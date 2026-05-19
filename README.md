# 产品概念图生成器

团队内部使用的 **Next.js + Tailwind + Electron** 产品概念图生成器。它面向产品设计和选品预览：上传产品参考图、可选图案素材图，再输入想修改的图案/颜色/位置/整体方向，调用 Kie 生图模型生成 1-10 张概念验证图。

## 核心能力

- **产品参考图**：必须至少 1 张，用于保持产品形状、材质、比例与关键结构。
- **图案素材图**：可选，用于 logo、花纹、印花、包装图案或纹理。
- **修改模式**：
  - `仅替换/新增表面图案`：保守保持产品结构，只改表面图案、印花、logo、颜色或装饰。
  - `整体重设产品概念`：允许改变轮廓、材质和视觉方向，用于更自由的概念探索。
- **双模型适配**：
  - GPT Image 2 · Image to Image：通过 Kie `input.input_urls` 创建任务。
  - Nano Banana Pro · Concept Image：通过 Kie `input.image_input` 创建任务。
- **历史与下载**：保留团队历史、一键下载、全部下载、默认下载目录设置。

## 环境要求

- Node.js 20+（含 npm），用于安装依赖与运行 `npm run dev` / 打包。
- **设置 → API Key**：Key 写入 `data/store.json`（或通过环境变量 `KIE_API_KEY`，优先级更高）。

## 可选环境变量

| 变量 | 说明 |
|------|------|
| `KIE_API_KEY` | 若设置，则覆盖 `data/store.json` 中的 Key，且设置页无法覆盖。 |
| `BLOB_READ_WRITE_TOKEN` | 若配置，则在无 Kie Key 时使用 Vercel Blob 上传公网 HTTPS 图片。 |
| `NEXT_PUBLIC_APP_URL` | 可选。用于本地上传后拼出的绝对 URL（反向代理、自定义域名）。 |
| `KIE_FILE_UPLOAD_BASE` | 可选。Kie 文件上传根地址，默认 `https://kieai.redpandaai.co`。 |

## 本地运行

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:3000`。

开发模式下数据默认在项目目录 `data/store.json`。

## 打包

项目使用 Next.js `output: "standalone"` 生成独立服务，再由 Electron 启动本地服务并打开窗口。

```bash
npm run build
npm run desktop:prepare
```

Windows 便携版可运行：

```bash
npm run desktop:pack
```

macOS release 由 `.github/workflows/build-v1-mac.yml` 按 tag 构建 x64 / arm64 zip。

## 常见问题

### “Image fetch failed. Check access settings or use our File Upload API instead.”

Kie 在云端拉取输入图片，`http://localhost...` 或内网地址会失败。

推荐在「设置」保存 Kie API Key 后再上传素材，本工具会优先走 Kie 文件上传接口，返回 Kie 可拉取的公网图片 URL。
