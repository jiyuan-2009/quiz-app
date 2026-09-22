require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

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
        const answerText = f['正确答案'] || '';
        if (answerText) {
          answer = answerText.split(',').map(a => {
            const letter = a.trim().toUpperCase();
            return letter.charCodeAt(0) - 65; // A->0, B->1...
          }).filter(n => n >= 0 && n <= 3);
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
          score: f['分值'] || (typeMap[typeText] === 'multi' ? 20 : 10),
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
// 提交答题结果
app.post('/api/records', async (req, res) => {
  try {
    const { name, team, phone, score, correctCount, prize, timeUsed } = req.body;

    if (!name || !team || !phone) {
      return res.status(400).json({ success: false, error: '请填写完整信息' });
    }
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
      'none': '未获奖'
    };

    const fields = {
      '姓名': name,
      '团队': team,
      '电话号码': phone,
      '得分': score || 0,
      '答对题数': correctCount || 0,
      '获奖等级': prizeMap[prize] || '未获奖',
      '答题用时': timeUsed || ''
    };

    const result = await feishuRequest(
      'POST',
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
      { fields }
    );

    res.json({ success: true, data: { record_id: result.data.record && result.data.record.record_id } });
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
    const records = allRecords.map(item => {
      const f = item.fields;
      const prizeField = f['获奖等级'];
      return {
        id: item.record_id,
        name: f['姓名'] || '',
        team: f['团队'] || '',
        phone: f['电话号码'] || '',
        score: f['得分'] || 0,
        correctCount: f['答对题数'] || 0,
        prize: Array.isArray(prizeField) ? prizeField[0] : prizeField || '未获奖',
        timeUsed: f['答题用时'] || '',
        createdAt: f['答题时间'] || item.created_time
      };
    }).sort((a, b) => b.score - a.score);

    // 统计
    const total = records.length;
    const avgScore = total > 0 ? Math.round(records.reduce((s, r) => s + r.score, 0) / total) : 0;
    const prizeCount = records.filter(r => r.score >= 80).length;

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
