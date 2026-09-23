require('dotenv').config();

// 白名单表ID默认值（可通过环境变量 WHITELIST_TABLE_ID 覆盖）
if (!process.env.WHITELIST_TABLE_ID) {
  process.env.WHITELIST_TABLE_ID = 'tblPgabes3cQ8VN7';
}

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const xlsx = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ========== 飞书 API 封装 ==========
const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
let tenantToken = null;
let tokenExpireTime = 0;

async function getTenantToken() {
  const now = Date.now();
  if (tenantToken && now < tokenExpireTime - 60000) {
    return tenantToken;
  }

  try {
    const res = await axios.post(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    });

    if (res.data.code === 0) {
      tenantToken = res.data.tenant_access_token;
      tokenExpireTime = now + res.data.expire * 1000;
      return tenantToken;
    }
    throw new Error('获取 tenant_access_token 失败: ' + res.data.msg);
  } catch (err) {
    console.error('获取 token 失败:', err.message);
    throw err;
  }
}

async function feishuRequest(method, path, data = null, params = null) {
  const token = await getTenantToken();
  const url = `${FEISHU_BASE}${path}`;

  const config = {
    method,
    url,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  };

  if (data) config.data = data;
  if (params) config.params = params;

  try {
    const res = await axios(config);
    if (res.data.code !== 0) {
      throw new Error(`飞书 API 错误 [${res.data.code}]: ${res.data.msg}`);
    }
    return res.data;
  } catch (err) {
    console.error('飞书 API 请求失败:', err.message);
    throw err;
  }
}

// ========== 题库接口 ==========

// 获取所有启用的题目
app.get('/api/questions', async (req, res) => {
  try {
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.QUIZ_TABLE_ID;

    // 分页获取所有记录
    let allRecords = [];
    let pageToken = null;

    do {
      const params = {
        page_size: 100,
        ...(pageToken && { page_token: pageToken })
      };

      const result = await feishuRequest(
        'GET',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
        null,
        params
      );

      if (result.data && result.data.items) {
        allRecords = allRecords.concat(result.data.items);
      }
      pageToken = result.data && result.data.page_token && result.data.has_more ? result.data.page_token : null;
    } while (pageToken);

    // 转换格式
    const questions = allRecords
      .filter(item => {
        const fields = item.fields;
        const status = fields['状态'];
        // 只返回启用状态的题目
        return !status || (Array.isArray(status) && status.includes('启用')) || status === '启用';
      })
      .map(item => {
        const f = item.fields;
        const typeText = Array.isArray(f['题目类型']) ? f['题目类型'][0] : f['题目类型'];
        const typeMap = { '单选': 'single', '多选': 'multi', '判断': 'judge' };

        // 解析正确答案
        let answer = [];
        let answerText = f['正确答案'] || '';
        // 处理数组格式（Bitable单选字段可能返回数组）
        if (Array.isArray(answerText)) {
          answerText = answerText[0] || '';
        }
        if (answerText) {
          let letters = [];
          // 兼容两种格式：逗号分隔(A,B,C) 和 连写(ABC)
          if (answerText.includes(',') || answerText.includes('，') || answerText.includes('、')) {
            letters = answerText.split(/[,，、]/).map(a => a.trim().toUpperCase()).filter(Boolean);
          } else {
            // 连写格式，每个字符都是一个答案字母
            letters = answerText.toUpperCase().split('').filter(c => c >= 'A' && c <= 'D');
          }
          answer = letters.map(letter => letter.charCodeAt(0) - 65)
            .filter(n => n >= 0 && n <= 3);
        }

        // 收集选项（过滤空选项）
        const options = [];
        ['选项A', '选项B', '选项C', '选项D'].forEach(key => {
          if (f[key] && f[key].trim()) {
            options.push(f[key].trim());
          }
        });

        // 难度字段
        const difficultyText = Array.isArray(f['难度']) ? f['难度'][0] : f['难度'];
        const difficultyMap = { '简单': 'easy', '中等': 'medium', '困难': 'hard' };

        return {
          id: item.record_id,
          type: typeMap[typeText] || 'single',
          question: f['题目内容'] || '',
          options,
          answer,
          score: Number(f['分值']) || (typeMap[typeText] === 'multi' ? 20 : 10),
          difficulty: difficultyMap[difficultyText] || 'medium'
        };
      });

    res.json({ success: true, data: questions, total: questions.length });
  } catch (err) {
    console.error('获取题目失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 添加题目
app.post('/api/questions', async (req, res) => {
  try {
    const { type, question, options, answer, score } = req.body;

    if (!question || !options || options.length < 2) {
      return res.status(400).json({ success: false, error: '题目内容和选项不能为空' });
    }

    const typeMap = { single: '单选', multi: '多选', judge: '判断' };
    const typeText = typeMap[type] || '单选';

    // 答案转字母
    const answerLetters = (answer || []).map(i => String.fromCharCode(65 + i)).join(',');

    const fields = {
      '题目类型': typeText,
      '题目内容': question,
      '选项A': options[0] || '',
      '选项B': options[1] || '',
      '选项C': options[2] || '',
      '选项D': options[3] || '',
      '正确答案': answerLetters,
      '分值': score || (type === 'multi' ? 20 : 10),
      '状态': '启用'
    };

    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.QUIZ_TABLE_ID;

    const result = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
      { fields }
    );

    res.json({ success: true, data: { record_id: result.data.record && result.data.record.record_id } });
  } catch (err) {
    console.error('添加题目失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新题目
app.put('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { type, question, options, answer, score, status } = req.body;

    const typeMap = { single: '单选', multi: '多选', judge: '判断' };
    const fields = {};

    if (type) fields['题目类型'] = typeMap[type] || '单选';
    if (question !== undefined) fields['题目内容'] = question;
    if (options) {
      fields['选项A'] = options[0] || '';
      fields['选项B'] = options[1] || '';
      fields['选项C'] = options[2] || '';
      fields['选项D'] = options[3] || '';
    }
    if (answer) {
      fields['正确答案'] = answer.map(i => String.fromCharCode(65 + i)).join(',');
    }
    if (score !== undefined) fields['分值'] = score;
    if (status !== undefined) fields['状态'] = status ? '启用' : '禁用';

    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.QUIZ_TABLE_ID;

    await feishuRequest(
      'PUT',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${id}`,
      { fields }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('更新题目失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除题目
app.delete('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.QUIZ_TABLE_ID;

    await feishuRequest(
      'DELETE',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${id}`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('删除题目失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== 题库批量导入导出 ==========

// 导出题库为 Excel
app.get('/api/questions/export', async (req, res) => {
  try {
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.QUIZ_TABLE_ID;
    const token = await getTenantToken();

    // 分页获取所有题目
    let allItems = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ page_size: 100 });
      if (pageToken) params.append('page_token', pageToken);
      const resp = await axios.get(
        `${FEISHU_BASE}/bitable/v1/apps/${baseToken}/tables/${tableId}/records?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      allItems = allItems.concat(resp.data.data.items);
      pageToken = resp.data.data.has_more ? resp.data.data.page_token : null;
    } while (pageToken);

    // 转换为 Excel 行
    const typeMap = { '单选': 'single', '多选': 'multi', '判断': 'judge' };
    const rows = allItems.map(item => {
      const f = item.fields;
      const typeText = Array.isArray(f['题目类型']) ? f['题目类型'][0] : f['题目类型'];
      const difficultyText = Array.isArray(f['难度']) ? f['难度'][0] : f['难度'];
      const statusText = Array.isArray(f['状态']) ? f['状态'][0] : f['状态'];

      // 解析答案
      let answerText = f['正确答案'] || '';
      if (Array.isArray(answerText)) answerText = answerText[0] || '';

      return {
        '题目类型': typeText || '',
        '题目内容': f['题目内容'] || '',
        '选项A': f['选项A'] || '',
        '选项B': f['选项B'] || '',
        '选项C': f['选项C'] || '',
        '选项D': f['选项D'] || '',
        '正确答案': answerText,
        '分值': Number(f['分值']) || 0,
        '难度': difficultyText || '',
        '状态': statusText || '启用'
      };
    });

    // 生成 Excel
    const ws = xlsx.utils.json_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, '题库');

    // 设置列宽
    ws['!cols'] = [
      { wch: 10 }, { wch: 50 }, { wch: 30 }, { wch: 30 },
      { wch: 30 }, { wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 8 }
    ];

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = `题库导出_${new Date().toISOString().slice(0,10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.send(buf);

  } catch (err) {
    console.error('导出失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 批量导入题库（Excel base64）
app.post('/api/questions/import', async (req, res) => {
  try {
    const { fileBase64, fileName } = req.body;
    if (!fileBase64) {
      return res.status(400).json({ success: false, error: '请上传文件' });
    }

    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.QUIZ_TABLE_ID;
    const token = await getTenantToken();

    // 解析 Excel
    const buf = Buffer.from(fileBase64, 'base64');
    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws);

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: '文件中没有数据' });
    }

    // 逐行解析并写入
    const typeMap = {
      '单选': '单选', '单选题': '单选', 'single': '单选',
      '多选': '多选', '多选题': '多选', 'multi': '多选',
      '判断': '判断', '判断题': '判断', 'judge': '判断'
    };

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    // 批量写入，每次最多 500 条（飞书限制）
    const batchSize = 100;
    const records = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lineNum = i + 2; // Excel 行号，第1行是表头

      try {
        const typeRaw = String(row['题目类型'] || row['题型'] || '').trim();
        const type = typeMap[typeRaw] || typeRaw;
        if (!type || !['单选', '多选', '判断'].includes(type)) {
          throw new Error(`题目类型无效: "${typeRaw}"`);
        }

        const question = String(row['题目内容'] || row['题目'] || '').trim();
        if (!question) {
          throw new Error('题目内容为空');
        }

        const optionA = String(row['选项A'] || row['A'] || '').trim();
        const optionB = String(row['选项B'] || row['B'] || '').trim();
        const optionC = String(row['选项C'] || row['C'] || '').trim();
        const optionD = String(row['选项D'] || row['D'] || '').trim();

        // 判断题只有两个选项
        let fields = {
          '题目类型': type,
          '题目内容': question,
        };

        if (type === '判断') {
          fields['选项A'] = '正确';
          fields['选项B'] = '错误';
        } else {
          if (optionA) fields['选项A'] = optionA;
          if (optionB) fields['选项B'] = optionB;
          if (optionC) fields['选项C'] = optionC;
          if (optionD) fields['选项D'] = optionD;
        }

        // 正确答案
        let answer = String(row['正确答案'] || row['答案'] || '').trim().toUpperCase();
        if (!answer) {
          throw new Error('正确答案为空');
        }

        // 判断题特殊处理
        if (type === '判断') {
          if (['正确', '对', '是', 'TRUE', 'T', 'A', '0'].includes(answer.toUpperCase())) {
            answer = 'A';
          } else if (['错误', '错', '否', 'FALSE', 'F', 'B', '1'].includes(answer.toUpperCase())) {
            answer = 'B';
          }
        }

        // 标准化答案格式（统一存为连写，如 ABC）
        if (answer.includes(',') || answer.includes('，') || answer.includes('、')) {
          answer = answer.split(/[,，、]/).map(a => a.trim().toUpperCase()).filter(Boolean).join('');
        }
        // 去掉空格
        answer = answer.replace(/\s/g, '');

        fields['正确答案'] = answer;

        // 分值
        const score = Number(row['分值'] || row['分数']) || 0;
        if (score > 0) fields['分值'] = score;

        // 难度
        const difficulty = String(row['难度'] || '').trim();
        if (difficulty && ['简单', '中等', '困难'].includes(difficulty)) {
          fields['难度'] = difficulty;
        }

        // 状态
        const status = String(row['状态'] || '启用').trim();
        fields['状态'] = status === '禁用' ? '禁用' : '启用';

        records.push({ fields });
        successCount++;
      } catch (err) {
        failCount++;
        errors.push(`第${lineNum}行: ${err.message}`);
      }
    }

    // 批量写入飞书
    if (records.length > 0) {
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        await axios.post(
          `${FEISHU_BASE}/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_create`,
          { records: batch },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }
    }

    res.json({
      success: true,
      total: rows.length,
      successCount,
      failCount,
      errors: errors.slice(0, 20) // 最多返回20条错误
    });

  } catch (err) {
    console.error('导入失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 批量更新题目分值
// 新分值规则：单选9分、多选14分、判断9分
app.post('/api/questions/batch-update-scores', async (req, res) => {
  try {
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.QUIZ_TABLE_ID;

    // 1. 获取所有题目
    let allRecords = [];
    let pageToken = null;
    do {
      const params = {
        page_size: 100,
        ...(pageToken && { page_token: pageToken })
      };
      const result = await feishuRequest(
        'GET',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
        null,
        params
      );
      if (result.data && result.data.items) {
        allRecords = allRecords.concat(result.data.items);
      }
      pageToken = result.data && result.data.page_token && result.data.has_more ? result.data.page_token : null;
    } while (pageToken && allRecords.length < 1000);

    // 2. 定义新分值
    const scoreMap = {
      'single': 9,
      'multi': 14,
      'judge': 9
    };

    // 3. 找出需要更新的记录并批量更新
    const toUpdate = [];
    allRecords.forEach(item => {
      const f = item.fields;
      const typeField = f['题型'];
      const type = Array.isArray(typeField) ? typeField[0] : typeField;
      const currentScore = Number(f['分值']) || 0;
      const newScore = scoreMap[type];
      if (newScore && currentScore !== newScore) {
        toUpdate.push({
          record_id: item.record_id,
          fields: { '分值': newScore },
          type,
          oldScore: currentScore,
          newScore
        });
      }
    });

    // 批量更新（每次最多500条）
    let updatedCount = 0;
    const batchSize = 500;
    for (let i = 0; i < toUpdate.length; i += batchSize) {
      const batch = toUpdate.slice(i, i + batchSize).map(u => ({
        record_id: u.record_id,
        fields: u.fields
      }));
      await feishuRequest(
        'POST',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_update`,
        { records: batch }
      );
      updatedCount += batch.length;
    }

    // 统计各题型更新数量
    const typeStats = {};
    toUpdate.forEach(u => {
      const key = `${u.type}: ${u.oldScore}→${u.newScore}`;
      typeStats[key] = (typeStats[key] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        total: allRecords.length,
        updated: updatedCount,
        unchanged: allRecords.length - updatedCount,
        typeStats
      }
    });
  } catch (err) {
    console.error('批量更新分值失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== 白名单接口 ==========

// 检查是否在白名单内（优先手机号，其次姓名匹配）
app.get('/api/whitelist/check', async (req, res) => {
  try {
    const { name, team, phone } = req.query;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    if (!tableId) {
      // 未配置白名单表，默认允许
      return res.json({ success: true, allowed: true, inWhitelist: false });
    }

    let exists = false;

    // 优先用手机号匹配
    if (phone) {
      const phoneResult = await feishuRequest(
        'POST',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search`,
        {
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: '手机号', operator: 'is', value: [phone] },
              { field_name: '状态', operator: 'is', value: ['启用'] }
            ]
          },
          page_size: 1
        }
      );
      exists = phoneResult.data && phoneResult.data.items && phoneResult.data.items.length > 0;
    }

    // 手机号没匹配到或没提供，用姓名匹配（不校验部门）
    if (!exists && name) {
      const nameResult = await feishuRequest(
        'POST',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search`,
        {
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: '姓名', operator: 'is', value: [name] },
              { field_name: '状态', operator: 'is', value: ['启用'] }
            ]
          },
          page_size: 1
        }
      );
      exists = nameResult.data && nameResult.data.items && nameResult.data.items.length > 0;
    }

    if (!phone && !name) {
      return res.status(400).json({ success: false, error: '请提供手机号或姓名' });
    }

    res.json({ success: true, allowed: exists, inWhitelist: exists });
  } catch (err) {
    console.error('白名单检查失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取白名单列表
app.get('/api/whitelist', async (req, res) => {
  try {
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    if (!tableId) {
      return res.json({ success: true, data: [], total: 0 });
    }

    const { page = 1, pageSize = 50, keyword } = req.query;
    const pageNum = parseInt(page) || 1;
    const size = parseInt(pageSize) || 50;

    let allRecords = [];
    let pageToken = null;

    do {
      const params = { page_size: 100 };
      if (pageToken) params.page_token = pageToken;

      const result = await feishuRequest(
        'GET',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
        null,
        params
      );

      if (result.data && result.data.items) {
        allRecords = allRecords.concat(result.data.items);
      }
      pageToken = result.data && result.data.has_more ? result.data.page_token : null;
    } while (pageToken && allRecords.length < 2000);

    // 关键词过滤
    if (keyword) {
      const kw = keyword.toLowerCase();
      allRecords = allRecords.filter(item => {
        const f = item.fields;
        return (f['姓名'] || '').toLowerCase().includes(kw) ||
               (f['部门'] || '').toLowerCase().includes(kw) ||
               (f['手机号'] || '').includes(kw) ||
               (f['工号'] || '').toLowerCase().includes(kw);
      });
    }

    // 分页
    const total = allRecords.length;
    const start = (pageNum - 1) * size;
    const pageData = allRecords.slice(start, start + size).map(item => {
      const f = item.fields;
      const statusField = f['状态'];
      return {
        id: item.record_id,
        name: f['姓名'] || '',
        team: f['部门'] || '',
        phone: f['手机号'] || '',
        employeeNo: f['工号'] || '',
        status: Array.isArray(statusField) ? statusField[0].text : statusField || '启用'
      };
    });

    res.json({ success: true, data: pageData, total, page: pageNum, pageSize: size });
  } catch (err) {
    console.error('获取白名单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 添加白名单人员
app.post('/api/whitelist', async (req, res) => {
  try {
    const { name, team, phone, employeeNo } = req.body;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    if (!name || !team) {
      return res.status(400).json({ success: false, error: '姓名和部门必填' });
    }

    // 重名校验：检查是否已存在同名人员
    const duplicateCheck = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search`,
      {
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '姓名', operator: 'is', value: [name] },
            { field_name: '状态', operator: 'is', value: ['启用'] }
          ]
        },
        page_size: 10
      }
    );

    const duplicates = duplicateCheck.data && duplicateCheck.data.items ? duplicateCheck.data.items : [];
    if (duplicates.length > 0) {
      const dupInfo = duplicates.map(d => `${d.fields['姓名']}（${d.fields['部门'] || '未填部门'}）`).join('、');
      return res.status(400).json({
        success: false,
        error: `白名单中已存在同名人员：${dupInfo}`,
        duplicate: true,
        duplicateCount: duplicates.length
      });
    }

    const fields = {
      '姓名': name,
      '部门': team,
      '状态': '启用'
    };
    if (phone) fields['手机号'] = phone;
    if (employeeNo) fields['工号'] = employeeNo;

    const result = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
      { fields }
    );

    res.json({ success: true, data: { record_id: result.data.record && result.data.record.record_id } });
  } catch (err) {
    console.error('添加白名单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 批量更新白名单人员
app.put('/api/whitelist/batch-update', async (req, res) => {
  try {
    const { ids, fields } = req.body;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: '请选择要更新的人员' });
    }
    if (!fields || Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, error: '请提供要更新的字段' });
    }

    // 只允许更新的字段
    const allowedFields = ['部门', '手机号', '工号', '状态'];
    const updateFields = {};
    for (const key of Object.keys(fields)) {
      if (allowedFields.includes(key)) {
        updateFields[key] = fields[key];
      }
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ success: false, error: '没有可更新的字段' });
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    // 逐条更新（Bitable API 单条更新）
    for (let i = 0; i < ids.length; i++) {
      try {
        await feishuRequest(
          'PUT',
          `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${ids[i]}`,
          { fields: updateFields }
        );
        successCount++;
      } catch (e) {
        failCount++;
        errors.push({ id: ids[i], message: e.message });
      }
    }

    res.json({
      success: true,
      data: { successCount, failCount, total: ids.length, errors: errors.slice(0, 10) }
    });
  } catch (err) {
    console.error('批量更新白名单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 批量删除白名单人员
app.delete('/api/whitelist/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: '请选择要删除的人员' });
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < ids.length; i++) {
      try {
        await feishuRequest(
          'DELETE',
          `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${ids[i]}`
        );
        successCount++;
      } catch (e) {
        failCount++;
      }
    }

    res.json({ success: true, data: { successCount, failCount, total: ids.length } });
  } catch (err) {
    console.error('批量删除白名单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除白名单人员
app.delete('/api/whitelist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    await feishuRequest(
      'DELETE',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${id}`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('删除白名单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 批量导入白名单（Excel）
app.post('/api/whitelist/import', async (req, res) => {
  try {
    const { fileBase64, fileName } = req.body;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    if (!fileBase64) {
      return res.status(400).json({ success: false, error: '请上传文件' });
    }

    const buf = Buffer.from(fileBase64, 'base64');
    const workbook = xlsx.read(buf, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet);

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: '文件为空' });
    }

    let successCount = 0;
    let failCount = 0;
    let errors = [];

    // 批量写入
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const records = [];

      batch.forEach((row, idx) => {
        const name = row['姓名'] || row['name'] || '';
        const team = row['部门'] || row['team'] || '';
        const phone = String(row['手机号'] || row['phone'] || '').trim();
        const employeeNo = String(row['工号'] || row['employeeNo'] || '').trim();

        if (!name || !team) {
          failCount++;
          errors.push({ row: i + idx + 2, message: '姓名和部门必填' });
          return;
        }

        records.push({
          fields: {
            '姓名': name,
            '部门': team,
            '手机号': phone,
            '工号': employeeNo,
            '状态': '启用'
          }
        });
        successCount++;
      });

      if (records.length > 0) {
        await feishuRequest(
          'POST',
          `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_create`,
          { records }
        );
      }
    }

    res.json({
      success: true,
      total: rows.length,
      successCount,
      failCount,
      errors
    });
  } catch (err) {
    console.error('导入白名单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 导出自名单
app.get('/api/whitelist/export', async (req, res) => {
  try {
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.WHITELIST_TABLE_ID;

    let allRecords = [];
    let pageToken = null;

    do {
      const params = { page_size: 100 };
      if (pageToken) params.page_token = pageToken;

      const result = await feishuRequest(
        'GET',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
        null,
        params
      );

      if (result.data && result.data.items) {
        allRecords = allRecords.concat(result.data.items);
      }
      pageToken = result.data && result.data.has_more ? result.data.page_token : null;
    } while (pageToken && allRecords.length < 5000);

    const data = allRecords.map(item => {
      const f = item.fields;
      const statusField = f['状态'];
      return {
        '姓名': f['姓名'] || '',
        '部门': f['部门'] || '',
        '手机号': f['手机号'] || '',
        '工号': f['工号'] || '',
        '状态': Array.isArray(statusField) ? statusField[0].text : statusField || '启用'
      };
    });

    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, '白名单');
    const excelBuf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="whitelist_${Date.now()}.xlsx"`);
    res.send(excelBuf);
  } catch (err) {
    console.error('导出白名单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== 答题记录接口 ==========
// 检查手机号是否已答过题
// 检查是否已答过题（支持手机号 或 姓名+团队 校验）
app.get('/api/records/check', async (req, res) => {
  try {
    const { phone, name, team } = req.query;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.RECORD_TABLE_ID;

    let conditions = [];

    // 优先用手机号检查
    if (phone) {
      conditions.push({
        field_name: '电话号码',
        operator: 'is',
        value: [phone]
      });
    }
    // 如果同时传了姓名和团队，也检查姓名+团队组合
    else if (name && team) {
      conditions.push(
        { field_name: '姓名', operator: 'is', value: [name] },
        { field_name: '团队', operator: 'is', value: [team] }
      );
    } else {
      return res.status(400).json({ success: false, error: '请提供手机号或姓名+团队' });
    }

    const result = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search`,
      {
        filter: {
          conjunction: 'and',
          conditions
        },
        page_size: 1
      }
    );

    const exists = result.data && result.data.items && result.data.items.length > 0;
    res.json({ success: true, exists });
  } catch (err) {
    console.error('检查失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// 内存级防重锁（应对并发竞态）
const submittingPhones = new Set();

// 提交答题结果
app.post('/api/records', async (req, res) => {
  try {
    const { name, team, phone, score, correctCount, prize, timeUsed } = req.body;

    if (!name || !team || !phone) {
      return res.status(400).json({ success: false, error: '请填写完整信息' });
    }

    // 白名单校验：如果配置了白名单表，必须在白名单内才能答题
    const whitelistTableId = process.env.WHITELIST_TABLE_ID;
    if (whitelistTableId) {
      const baseToken = process.env.FEISHU_BASE_TOKEN;
      let whitelistConditions = [];

      // 优先用手机号匹配
      whitelistConditions.push(
        { field_name: '手机号', operator: 'is', value: [phone] },
        { field_name: '状态', operator: 'is', value: ['启用'] }
      );

      const whitelistCheck = await feishuRequest(
        'POST',
        `/bitable/v1/apps/${baseToken}/tables/${whitelistTableId}/records/search`,
        {
          filter: {
            conjunction: 'and',
            conditions: whitelistConditions
          },
          page_size: 1
        }
      );

      let inWhitelist = whitelistCheck.data && whitelistCheck.data.items && whitelistCheck.data.items.length > 0;

      // 手机号没匹配到，再用姓名匹配（不校验部门）
      if (!inWhitelist) {
        const nameCheck = await feishuRequest(
          'POST',
          `/bitable/v1/apps/${baseToken}/tables/${whitelistTableId}/records/search`,
          {
            filter: {
              conjunction: 'and',
              conditions: [
                { field_name: '姓名', operator: 'is', value: [name] },
                { field_name: '状态', operator: 'is', value: ['启用'] }
              ]
            },
            page_size: 1
          }
        );
        inWhitelist = nameCheck.data && nameCheck.data.items && nameCheck.data.items.length > 0;
      }

      if (!inWhitelist) {
        return res.status(400).json({ success: false, error: '您不在答题白名单内，请联系管理员添加' });
      }
    }

    // 内存级防重：同一手机号正在提交中直接拒绝
    if (submittingPhones.has(phone)) {
      return res.status(400).json({ success: false, error: '提交中，请稍候...' });
    }
    submittingPhones.add(phone);

    try {
    // 检查是否已答过题（每人只能答一次）—— 双重校验：手机号 或 姓名+团队
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.RECORD_TABLE_ID;

    // 检查1：手机号是否已存在
    const phoneCheck = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search`,
      {
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '电话号码',
              operator: 'is',
              value: [phone]
            }
          ]
        },
        page_size: 1
      }
    );

    if (phoneCheck.data && phoneCheck.data.items && phoneCheck.data.items.length > 0) {
      return res.status(400).json({ success: false, error: '您已经参与过答题，每人仅限一次' });
    }

    // 检查2：姓名+团队组合是否已存在（防止换手机号重复答题）
    const nameTeamCheck = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search`,
      {
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '姓名',
              operator: 'is',
              value: [name]
            },
            {
              field_name: '团队',
              operator: 'is',
              value: [team]
            }
          ]
        },
        page_size: 1
      }
    );

    if (nameTeamCheck.data && nameTeamCheck.data.items && nameTeamCheck.data.items.length > 0) {
      return res.status(400).json({ success: false, error: '您已经参与过答题，每人仅限一次' });
    }
    const prizeMap = {
      'first': '一等奖',
      'second': '二等奖',
      'third': '三等奖',
      'participation': '参与奖',
      'none': '谢谢参与'
    };

    const fields = {
      '姓名': name,
      '团队': team,
      '电话号码': phone,
      '得分': score || 0,
      '答对题数': correctCount || 0,
      '获奖等级': prizeMap[prize] || '谢谢参与',
      '答题用时': timeUsed || ''
    };

    const result = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
      { fields }
    );

    res.json({ success: true, data: { record_id: result.data.record && result.data.record.record_id } });
    } finally {
      submittingPhones.delete(phone);
    }
  } catch (err) {
    console.error('提交记录失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取答题记录（排行榜）
app.get('/api/records', async (req, res) => {
  try {
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.RECORD_TABLE_ID;
    const limit = parseInt(req.query.limit) || 100;

    let allRecords = [];
    let pageToken = null;

    do {
      const params = {
        page_size: 100,
        ...(pageToken && { page_token: pageToken })
      };

      const result = await feishuRequest(
        'GET',
        `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
        null,
        params
      );

      if (result.data && result.data.items) {
        allRecords = allRecords.concat(result.data.items);
      }
      pageToken = result.data && result.data.page_token && result.data.has_more ? result.data.page_token : null;
    } while (pageToken && allRecords.length < 500);

    // 转换并按分数排序
    let records = allRecords.map(item => {
      const f = item.fields;
      const prizeField = f['获奖等级'];
      return {
        id: item.record_id,
        name: f['姓名'] || '',
        team: f['团队'] || '',
        phone: f['电话号码'] || '',
        score: Number(f['得分']) || 0,
        correctCount: Number(f['答对题数']) || 0,
        prize: Array.isArray(prizeField) ? prizeField[0] : prizeField || '谢谢参与',
        timeUsed: f['答题用时'] || '',
        createdAt: f['答题时间'] || item.created_time
      };
    }).sort((a, b) => b.score - a.score);

    // 按姓名+团队去重：同一人只保留最高分的一条记录（防止换手机号重复答题）
    const seen = new Map();
    records.forEach(r => {
      const key = `${r.name}__${r.team}`;
      if (!key || key === '__') return;
      if (!seen.has(key) || r.score > seen.get(key).score) {
        seen.set(key, r);
      }
    });
    records = Array.from(seen.values()).sort((a, b) => b.score - a.score);

    // 统计
    const total = records.length;
    const avgScore = total > 0 ? Math.round(records.reduce((s, r) => s + r.score, 0) / total) : 0;
    const prizeCount = records.filter(r => r.score >= 60).length;

    res.json({
      success: true,
      data: records.slice(0, limit),
      stats: { total, avgScore, prizeCount }
    });
  } catch (err) {
    console.error('获取记录失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== 健康检查 ==========
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ========== 启动服务 ==========
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🎯 知识答题系统已启动                   ║
║                                          ║
║   访问地址: http://localhost:${PORT}        ║
║   答题入口: http://localhost:${PORT}/#quiz  ║
║                                          ║
║   后端 API: /api/questions               ║
║            /api/records                  ║
╚══════════════════════════════════════════╝
  `);
});
