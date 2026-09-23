require('dotenv').config();
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

// ========== 答题记录接口 ==========
// 检查手机号是否已答过题
app.get('/api/records/check/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.RECORD_TABLE_ID;

    const result = await feishuRequest(
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

    const exists = result.data && result.data.items && result.data.items.length > 0;
    res.json({ success: true, exists });
  } catch (err) {
    console.error('检查手机号失败:', err);
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

    // 内存级防重：同一手机号正在提交中直接拒绝
    if (submittingPhones.has(phone)) {
      return res.status(400).json({ success: false, error: '提交中，请稍候...' });
    }
    submittingPhones.add(phone);

    try {
    // 检查是否已答过题（每人只能答一次）
    const baseToken = process.env.FEISHU_BASE_TOKEN;
    const tableId = process.env.RECORD_TABLE_ID;

    const checkResult = await feishuRequest(
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

    if (checkResult.data && checkResult.data.items && checkResult.data.items.length > 0) {
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

    // 按手机号去重：同一人只保留最高分的一条记录
    const seen = new Map();
    records.forEach(r => {
      const phone = r.phone;
      if (!phone) return;
      if (!seen.has(phone) || r.score > seen.get(phone).score) {
        seen.set(phone, r);
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
