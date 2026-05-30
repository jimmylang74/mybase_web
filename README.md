# 知识库 KBase v2.0

**Web of Mybase Knowledge Server** — 中文知识库管理系统，基于 Flask + PaddleOCR 构建。

支持多知识库（Tab）、树形菜单组织、富文本编辑、图片 OCR 文字识别、全文搜索、一键备份等功能。

## 功能特性

- 📚 **多知识库管理** — 支持创建多个独立知识库 Tab，拖拽排序，独立索引
- 🌳 **树形菜单** — 多级嵌套菜单组织内容，支持拖拽移动、内联重命名、自定义样式
- ✏️ **富文本编辑器** — 所见即所得编辑，支持字体/颜色/大小/粗斜体/链接等格式
- 🔍 **全文搜索** — SQLite 索引引擎，支持单库/全局搜索，支持正则表达式
- 🖼️ **OCR 图片文字识别** — 基于 PaddleOCR，自动提取图片文字并纳入索引
- 📦 **一键备份** — ZIP 打包所有知识库数据，支持下载
- 🌐 **独立导出** — 每个知识库可生成独立的单页 HTML（index.html）

## 安装

### 环境要求

- Python >= 3.8
- 操作系统：Windows / Linux / macOS

### 安装步骤

```bash
# 1. 克隆或下载项目
cd web-of-mybase

# 2. （推荐）创建虚拟环境
python -m venv venv
source venv/bin/activate    # Linux / macOS
venv\Scripts\activate       # Windows

# 3. 安装依赖
pip install -r requirements.txt
```

> **GPU 加速（可选）**：如需使用 GPU 加速 OCR，先卸载 CPU 版再安装 GPU 版：
> ```bash
> pip uninstall paddlepaddle -y
> pip install paddlepaddle-gpu
> ```

## 快速启动

```bash
# 默认启动（端口 9999）
python server.py
```

启动后打开浏览器访问：http://localhost:9999

## 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port PORT` | 9999 | 服务器监听端口 |
| `--data DIR` | data | 数据根目录 |
| `--force-index [NAME]` | — | 强制重建索引（指定名称或全部） |
| `--disable-ocr` | — | 禁用 OCR 图片文字识别 |
| `--workers-ocr N` | 8 | OCR 工作进程数 |
| `--workers-menu N` | 8 | 菜单项索引并行数 |
| `--no-debug` | — | 关闭调试日志 |

### 使用示例

```bash
# 指定端口和数据目录
python server.py --port 8080 --data /path/to/data

# 启动时强制重建所有索引
python server.py --force-index

# 重建指定知识库索引 + 禁用 OCR
python server.py --force-index my_kb --disable-ocr

# 低资源环境（减少并行数）
python server.py --workers-ocr 2 --workers-menu 2
```

## 目录结构

```
├── server.py              # 主服务器程序
├── requirements.txt       # Python 依赖
├── web/
│   ├── templates/         # HTML 模板
│   │   ├── index.html     # 主界面
│   │   └── help.html      # 帮助文档
│   └── static/
│       ├── app.js         # 前端逻辑
│       └── style.css      # 样式表
├── data/
│   ├── mybase/            # 知识库数据
│   │   └── <知识库名>/
│   │       ├── menu.json  # 菜单结构
│   │       ├── menu.js    # 前端菜单数据
│   │       ├── index.html # 独立导出页面
│   │       ├── content/   # 内容文件
│   │       └── images/    # 上传的图片
│   └── db/
│       ├── common.db      # 通用配置数据库
│       └── index_db/      # 搜索索引数据库
├── models/
│   └── ocr/               # OCR 模型缓存
└── mybase.log             # 运行日志
```

## 使用指南

### 基本操作

1. **创建知识库** — 点击工具栏「新增知识库」按钮
2. **添加菜单项** — 在侧边栏右键菜单选择「新增根菜单项」或「新增子菜单项」
3. **编辑内容** — 点击菜单项，在右侧富文本编辑器中编辑
4. **保存** — `Ctrl + S` 或点击「💾 Save」按钮
5. **搜索** — 在搜索框输入关键词，支持全局搜索和正则搜索

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + S` | 保存当前内容 |
| `Esc` | 关闭弹出菜单/对话框 |
| 双击菜单项 | 内联重命名 |

### 数据备份

点击工具栏「📦 备份知识库」按钮，系统将打包所有数据为 ZIP 文件并提供下载。

## 索引系统

- 服务器启动时自动检测并索引新知识库
- 保存内容时自动增量更新索引
- 支持 OCR 图片文字提取并纳入索引
- 可通过 `--force-index` 手动强制重建索引

## OCR 说明

- 默认启用 OCR，使用 PaddleOCR 识别图片中的文字
- OCR 在独立进程池中运行，不影响主服务器响应
- 不需要时可用 `--disable-ocr` 关闭以节省资源
- 首次使用会自动下载 OCR 模型（约 100MB）

## 常见问题

**Q: 启动报错 `ModuleNotFoundError: No module named 'paddle'`**  
A: 请确保已安装 paddlepaddle：`pip install paddlepaddle`

**Q: OCR 识别速度慢**  
A: CPU 模式下首次加载模型较慢是正常的。可调整 `--workers-ocr` 增加/减少进程数。

**Q: 如何修改端口？**  
A: 使用 `--port` 参数：`python server.py --port 8080`

**Q: 如何迁移数据？**  
A: 拷贝整个 `data/` 目录，启动时用 `--data` 指定新路径即可。

## License

MIT
