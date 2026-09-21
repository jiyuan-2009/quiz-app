# 🎯 知识答题小程序（飞书多维表格后端版）

基于飞书多维表格的多人共享答题系统，支持扫码答题、题库管理、成绩排行。

## ✨ 功能特性

- 📝 **扫码答题** — 生成二维码，手机扫码即可登记答题
- 📚 **题库管理** — 支持单选、多选、判断题，可增删改查
- 🎲 **随机出题** — 题目和选项随机出现，每次答题不重复
- 🏆 **自动评奖** — 一等奖(100分)、二等奖(90-99分)、三等奖(80-89分)
- 📊 **成绩排行** — 实时排行榜，统计参与人数、平均分、获奖人数
- 🔐 **管理员模式** — 密码保护的题库管理功能
- ☁️ **数据共享** — 题库和答题记录存储在飞书多维表格，多人实时同步

## 📋 答题规则

| 题型 | 数量 | 每题分值 | 小计 |
|------|------|----------|------|
| 单选题 | 4 道 | 10 分 | 40 分 |
| 多选题 | 2 道 | 20 分 | 40 分 |
| 判断题 | 2 道 | 10 分 | 20 分 |
| **合计** | **8 道** | - | **100 分** |

**奖项设置：**
- 🏆 一等奖：100 分（满分）
- 🥈 二等奖：90 ~ 99 分
- 🥉 三等奖：80 ~ 89 分

---

## 🚀 方案一：Render 免费部署（推荐 ⭐）

**无需服务器、无需信用卡、免费额度足够答题活动使用。**

### 第 1 步：准备飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/) → 创建「企业自建应用」
2. 获取 **App ID** 和 **App Secret**（在「凭证与基础信息」里）
3. 开通权限（权限管理 → 搜索添加）：
   - `bitable:app` — 多维表格应用权限
   - `bitable:record:read` — 读取记录
   - `bitable:record:write` — 写入记录
4. 发布版本（版本管理与发布 → 创建版本 → 申请发布）
5. 打开[知识答题系统多维表格](https://envision-energy.feishu.cn/base/W20CbpxemaMpuesZTSwcwE7enCf) → 右上角「...」→ 添加协作者 → 搜索你的应用名称 → 设为「可编辑」

### 第 2 步：准备 GitHub 仓库

1. 注册/登录 [GitHub](https://github.com/)
2. 新建一个仓库（比如叫 `quiz-app`），设为 Public
3. 把本项目的所有文件上传到仓库（可以直接网页拖拽上传）

### 第 3 步：部署到 Render

1. 访问 [Render.com](https://render.com/) → 右上角「Get Started」→ 用 GitHub 账号登录
2. 登录后点击「New +」→ 选「Web Service」
3. 选择你刚创建的 `quiz-app` 仓库 → 点击「Connect」
4. 填写配置：
   - **Name**: 随便起（比如 `my-quiz-app`），这个会成为你的访问地址
   - **Region**: 选 Singapore（新加坡，国内访问更快）
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. 点击「Advanced」→ 「Add Environment Variable」，添加以下变量：
   | Key | Value |
   |-----|-------|
   | `FEISHU_APP_ID` | 你的飞书应用 App ID（cli_ 开头） |
   | `FEISHU_APP_SECRET` | 你的飞书应用 App Secret |
   | `FEISHU_BASE_TOKEN` | `W20CbpxemaMpuesZTSwcwE7enCf` |
   | `QUIZ_TABLE_ID` | `tblQF6QmmICc4mEp` |
   | `RECORD_TABLE_ID` | `tblhvkWe0fmSVEz2` |
   | `ADMIN_PASSWORD` | 自己设一个管理员密码 |
   | `PORT` | `10000`（Render 默认用 10000） |
6. 点击「Create Web Service」
7. 等待 2~3 分钟，部署完成后会显示一个 `onrender.com` 结尾的网址

### 第 4 步：使用

- 访问 `https://你的应用名.onrender.com` 即可打开答题系统
- 手机扫码：进入「二维码」页面，用手机扫码就能答题
- 题库管理：首页点击「题库管理」→ 输入管理员密码

> **注意**：Render 免费版 15 分钟无访问会休眠，第一次打开可能需要等 20~30 秒（冷启动），之后就正常了。答题活动前先自己打开一次唤醒即可。

---

## 🚀 方案二：本地运行（快速测试）

```bash
# 1. 进入项目目录
cd quiz-app

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入飞书应用凭证

# 4. 启动服务
npm start
```

访问 http://localhost:3000 即可使用。

---

## 🚀 方案三：自有 Linux 服务器部署

如果你有阿里云/腾讯云服务器，用 PM2 守护进程：

```bash
# 1. 上传项目到服务器
scp -r quiz-app root@你的服务器IP:/opt/

# 2. 登录服务器
ssh root@你的服务器IP
cd /opt/quiz-app

# 3. 安装 Node.js（如未安装）
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# 4. 安装依赖和 PM2
npm install
npm install -g pm2

# 5. 配置环境变量
cp .env.example .env
vim .env  # 填入配置

# 6. 启动服务
pm2 start server.js --name quiz-app
pm2 save
pm2 startup  # 开机自启
```

然后用 `http://服务器IP:3000` 访问。如需 80 端口访问，用 Nginx 反向代理即可。

---

## 📱 使用流程

### 管理员

1. 访问系统首页
2. 点击「题库管理」→ 输入管理员密码登录
3. 添加/编辑/删除题目
4. 点击「二维码」→ 保存或打印二维码
5. 点击「答题排行」查看答题情况

### 答题者

1. 手机扫描二维码
2. 填写姓名、团队、电话号码
3. 开始答题（8 道题，随机顺序）
4. 提交后查看得分和获奖情况

---

## 📊 多维表格结构

### 题库表（tblQF6QmmICc4mEp）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| 题目类型 | 单选 | 单选 / 多选 / 判断 |
| 题目内容 | 文本 | 题面 |
| 选项A | 文本 | 选项 A 内容 |
| 选项B | 文本 | 选项 B 内容 |
| 选项C | 文本 | 选项 C 内容（判断题留空） |
| 选项D | 文本 | 选项 D 内容（判断题留空） |
| 正确答案 | 文本 | 单选/判断填字母，多选用逗号分隔，如 A,C,D |
| 分值 | 数字 | 该题分值 |
| 状态 | 单选 | 启用 / 禁用 |

### 答题记录表（tblhvkWe0fmSVEz2）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| 姓名 | 文本 | 答题人姓名 |
| 团队 | 文本 | 所属团队/部门 |
| 电话号码 | 文本 | 联系电话 |
| 得分 | 数字 | 答题得分 |
| 答对题数 | 数字 | 答对的题目数量 |
| 获奖等级 | 单选 | 一等奖/二等奖/三等奖/未获奖 |
| 答题用时 | 文本 | 如 2分30秒 |
| 答题时间 | 创建时间 | 自动记录 |

---

## 🔧 技术栈

- **后端**：Node.js + Express
- **前端**：原生 HTML + CSS + JavaScript
- **数据库**：飞书多维表格（Bitable）
- **二维码**：qrcode.js
- **部署**：Render / 自有服务器

---

## 📝 注意事项

1. **飞书应用权限**：确保应用已开通 bitable 权限，且已添加为多维表格的协作者
2. **Render 冷启动**：免费版 15 分钟无访问会休眠，活动前先打开一次
3. **并发限制**：飞书 API QPS 约 100，答题活动一般完全够用
4. **题目数量**：确保题库中各类型题目数量充足（单选≥4、多选≥2、判断≥2）
5. **管理员密码**：生产环境建议修改默认密码

---

## 🆘 常见问题

**Q: Render 部署后显示 "Application Error"？**
A: 检查环境变量是否填对，特别是 FEISHU_APP_ID 和 FEISHU_APP_SECRET。可以在 Render 控制台 → Logs 里看具体报错。

**Q: 飞书 API 报错 "permission denied"？**
A: 检查应用是否开通了 bitable 权限，以及是否已添加为多维表格的协作者。

**Q: 题目加载不出来？**
A: 检查环境变量中的 BASE_TOKEN 和 TABLE_ID 是否正确，题库表中是否有「启用」状态的题目。

**Q: Render 免费版够用吗？**
A: 答题活动场景完全够用。750 小时/月的免费额度 = 全天候运行一个服务。冷启动只影响第一次访问速度。

**Q: 想换个更好记的地址？**
A: Render 免费版支持绑定自定义域名，在 Settings → Custom Domains 里添加即可。

---

## 📄 许可证

MIT License
