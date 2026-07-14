# 山海神谕 · Shanhai Oracle

中国神话人物版神谕抽牌站。灵感来自 [Tarot Sanctuary](https://html.non.io/tarot) 的交互与氛围，重新演绎为山海经 / 中国神话语境。

## 功能

- **抽取神谕**：17 位神话人物（女娲、孙悟空、嫦娥、观音、哪吒、盘古、白素贞、后羿、龙王、伏羲、西王母、钟馗、精卫、夸父、刑天、雷公、门神）
- **WebGL2 卡牌光照**：法线 / 粗糙度 / 高度贴图 + 指针烛金 key light
- **3D 倾斜** + 动态阴影 + 抽牌飞入 / 翻面
- **再抽一卦**：卦辞淡出，页面随新牌缓缓上滑
- **立意**：明心 / 疗愈 / 指引 / 情缘
- **依心境问卦**：按情绪匹配相应人物
- **纯前端**：无登录、无后端存储，适合 Cloudflare 静态部署

## 本地开发

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址（默认 `http://localhost:8787`）。

也可直接用静态服务器打开 `public/`：

```bash
npx serve public
```

### 重新处理卡面资源

插画源图放入会话/设计目录后，用脚本生成 webp + PBR maps：

```bash
node scripts/process-assets.mjs
```

## 部署到 Cloudflare

本项目使用 **Workers Static Assets**（`wrangler.jsonc` → `assets.directory`）。

```bash
# 登录（首次）
npx wrangler login

# 部署
npm run deploy
```

### 绑定自定义域名

1. Cloudflare Dashboard → Workers & Pages → 本项目 → Settings → Domains & Routes
2. 添加 Custom Domain，填入你的域名  
   （域名在同一 Cloudflare 账号下时 DNS 会自动配置；否则按提示添加 CNAME）

或使用 Pages 方式：

```bash
npx wrangler pages deploy public --project-name=shanhai-oracle
```

## 结构

```
public/
  index.html / 404.html
  css/style.css              # 玄墨鎏金中式审美 + 原版布局
  js/
    deck.js                  # 17 张神话牌 + 心境 / 立意
    card.js                  # WebGL2 PBR、倾斜、抽牌、滚动跟随
  assets/
    bg.webp                  # 山海夜景
    paper-*.webp             # 按钮纸纹
    cards/
      {slug}.webp            # 漫反射
      {slug}-normal.webp
      {slug}-roughness.webp
      {slug}-height.webp
      cardBack*.webp
scripts/
  process-assets.mjs         # 插画 → webp + PBR
wrangler.jsonc
package.json
```

## 核心视觉

1. **插画卡面** — 深蓝底、鎏金框、星月花草  
2. **PBR 贴图** — normal / roughness / height  
3. **WebGL2 烛光** — 指针驱动，高度视差，金线高光  
4. **抽牌动画** — 旧牌飞出翻背，新牌自下升起翻面  
5. **3D 倾斜 + 动态阴影**

## 说明

- 解读文案供自我省思，**非占卜断语**。
- 月相 / 日期为本地时间 + 朔望月近似算法，仅作氛围点缀。
- 无私密数据上传；卦象只存在当前浏览器会话中。
