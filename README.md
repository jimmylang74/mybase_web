# 知识库 KBase v7.2.1

**Web of Mybase Knowledge Server**，中文知识库管理系统，基于 Flask + PaddleOCR 构建。

适用于个人、团队、家庭的知识库管理，为您和团队（家庭）提供一个便捷的经验累积的工具。是PM管理项目，提升团队协作的好帮手。

支持多知识库（Tab）、树形菜单组织、富文本编辑、图片 OCR 文字识别、全文搜索、一键备份等功能。

## 功能特性

V6.x ( In progress )
- **菜单项导出为Markdown**，支持将菜单项或整个知识库导出为MD文件，表格转为管道语法，Mermaid图表保留源代码块，图片打包到images目录
- **菜单项导出为PPT**，支持配置后端LLM，菜单项直接导出到LLM，由LLM总结后生成PPT (in progress)
- **Excel表格拷贝**，支持直接从Excel表格拷贝到网页内容区，保留字体，颜色，背景，对齐方式
- **图片内文字拷贝**,支持内容区域图片内的文字拷贝 (使用tesseract.js实现)
- **支持插入Mermaid图表**,支持在内容区域插入Mermaid语法的时序图/类图/思维导图等等 (使用mermaid.js实现)

V5.x
- **优化颜色选择器**，现在颜色选择器中增加常用颜色和透明色
- **优化菜单项移动到...界面**，现在移动到的界面可以直接搜索菜单项
- **手机屏幕适配**，简单的手机屏幕适配，菜单栏可以选择关闭显示
- **多用户管理**，可以支持多用户，Admin可以单独发布公告栏式的知识库
  admin 默认密码 1234，可以在设置中创建和删除用户
  admin 创建的知识库为公共知识库，所有用户可见（但不可编辑）
  admin 可以指定一个知识库的owner
  user  用户创建的知识库owner为自己，仅可见自己创建的知识库和admin发布的知识库
  user  仅能导出自己创建的知识库，不能导出和修改admin的知识库
  admin 对菜单项内容打修改通过websocket即时同步到所有登录的user，类似公告
  admii 删除一个用户后，这个用户所有知识库归属admin，已经登录的用户立即处于登出状
  admin/user 可以对自己创建的知识库进行加密，仅输入密码后知识库才可被阅读和编辑
- **支持团队讨论区**,admin的知识库大家都可以看，现在增加一种可以编辑的Tab，所有成员都可以编辑的讨论区
- **菜单项的拷贝和粘贴**,支持从一个知识库中把菜单项拷贝到另一个知识库
- **单用户版本**，支持参数设置以单用户方式运行


V4.x
- **内容区域文字背景色**，现在内容区域的文字可以设置背景色
- **搜索高亮**，内容区域的文字被搜索后高亮显示，暂不支持图片内文字高亮
- **商业发布需求**，支持 Cython 编译加速，提供 Makefile 构建脚本（make build / make package）
- **表格支持**，内容区域支持插入表格。表格可以通过鼠标拉伸宽度，单元格支持公式，单元格支持格式设定
- **图片、表格缩放**，内容区域的表格，图片支持鼠标拖动缩放

V3.x
- **菜单项PDF/ZIP 导出**，支持知识库级别和菜单项级别的 PDF/ZIP 格式导出，提供独立 HTML ZIP 输出
- **增加设置**，可以设置语言，目前只支持中英文
- **WebSocket 实时协作**，基于 flask-socketio 实现，支持多浏览器窗口自动同步、文档锁定防止冲突、加密库同步拒绝访问
- **知识库加密**，采用 AES-256-GCM 文件加密 + BCrypt 密码哈希 + PBKDF2 密钥派生，支持一库一密，基于会话解锁
- **mobile ocr**，支持小内存占用的mobile版本ocr推理模型，速度更快，占用内存更小

V2.x
- **树状菜单可以定制样式**，菜单项可以定制字体的前景、背景色，前置（或者后置）Emoji图标等
- **搜索支持正则表达式**，搜索可以使用标准语法的正则表达式
- **备份知识库**支持将运行程序、文档、库、知识库一起打包并下载到用户本地，让用户方便迁移到其他地方部署

V1.x
- 📚 **多知识库管理**，支持创建多个独立知识库 Tab，拖拽排序，独立索引
- 🌳 **树形菜单**，多级嵌套菜单组织内容，支持拖拽移动、内联重命名、自定义样式
- ✏️ **富文本编辑器**，所见即所得编辑，支持字体/颜色/大小/粗斜体/链接等格式
- 🔍 **全文搜索**，SQLite 索引引擎，支持单库/全局搜索，支持正则表达式、OR（<code>|</code>）、AND（空格/<code>&&</code>）、排除（<code>^</code>）智能搜索语法
- 🖼️ **OCR 图片文字识别**，基于 PaddleOCR，自动提取图片文字并纳入索引
- 📦 **一键备份**，ZIP 打包所有知识库数据，支持下载
- 🌐 **独立导出**，每个知识库可生成独立的单页 HTML（index.html）
- **支持Ubuntu、Windows下部署**, 支持在Ubuntu服务器或者windows个人电脑上部署

## 安装

### 环境要求

- Python >= 3.10
- 操作系统：Windows / Linux / macOS
- 主要依赖：flask-socketio>=5.3.0, fpdf2>=2.8.0, markdownify>=0.11.0, bcrypt>=4.0.0, pycryptodome>=3.20.0

### 安装步骤

```bash
# 1. 克隆或下载项目
cd web-of-mybase

# 2. （推荐）创建虚拟环境
python -m venv venv
source venv/bin/activate    # Linux / macOS
venv\Scripts\activate       # Windows

# 3. 安装依赖
windows 下如果没有安装过python，请先安装python-3.10.11-amd64.ex
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
| `--force-index [NAME]` | 无 | 强制重建索引（指定名称或全部） |
| `--disable-ocr` | 无 | 禁用 OCR 图片文字识别 |
| `--mobile-ocr` | true | 使用轻量级 Mobile OCR 模型（精度较低但内存占用更少）。Windows 上默认启用 |
| `--workers-ocr N` | 8 | OCR 工作进程数 |
| `--workers-menu N` | 8 | 菜单项索引并行数 |
| `--no-debug` | 无 | 关闭调试日志 |
| `--single-user` | 无 | 单用户模式，跳过登录直接以 admin 身份使用，隐藏登录/用户管理界面 |

### 使用示例

```bash
# 指定端口和数据目录
python server.py --port 8080 --data /path/to/data

# 启动时强制重建所有索引
python server.py --force-index

# 重建指定知识库索引 + 禁用 OCR
python server.py --force-index my_kb --disable-ocr

# 单用户模式（免登录，默认以 admin 身份使用）
python server.py --single-user

# 低资源环境（减少并行数）
python server.py --workers-ocr 2 --workers-menu 2
```

## 目录结构

```
├── server.py              # 主服务器程序
├── main.py                # Cython 加载器
├── setup.py               # Cython 构建脚本
├── Makefile               # 构建/清理/打包脚本
├── requirements.txt       # Python 依赖
├── pdf_fonts/             # PDF 导出字体目录
├── web/
│   ├── templates/         # HTML 模板
│   │   ├── index.html     # 主界面
│   │   └── help.html      # 帮助文档
│   └── static/
│       ├── app.js         # 前端逻辑
│       └── style.css      # 样式表
├── data/
│   ├── mybase/            # admin拥有的知识库数据
│   │   └── <知识库名>/
│   │       ├── menu.json  # 菜单结构
│   │       ├── menu.js    # 前端菜单数据
│   │       ├── index.html # 独立导出页面
│   │       ├── content/   # 内容文件
│   │       └── images/    # 上传的图片
│   ├── user/
│   │    └── <用户名>/     # 某个用户拥有的知识库
│   │          └── <知识库名>/
│   │              ├── menu.json  # 菜单结构
│   │              ├── menu.js    # 前端菜单数据
│   │              ├── index.html # 独立导出页面
│   │              ├── content/   # 内容文件
│   │              └── images/    # 上传的图片
│   │ 
│   └── db/
│       ├── common.db      # 通用配置数据库
│       └── index_db/      # 搜索索引数据库
├── models/
│   └── ocr/               # 预先下载好的Paddle OCR模型，包括Server版本和Mobile版本
└── mybase.log             # 运行日志
```

## 使用指南

### 基本操作

1. **创建知识库**，点击工具栏「新增知识库」按钮
2. **添加菜单项**，在侧边栏右键菜单选择「新增根菜单项」或「新增子菜单项」
3. **编辑内容**，点击菜单项，在右侧富文本编辑器中编辑
4. **保存**，`Ctrl + S` 或点击「💾 Save」按钮
5. **搜索**，在搜索框输入关键词，支持全局搜索、正则搜索，以及智能语法：OR（<code>|</code>）、AND（空格/<code>&&</code>）、排除（<code>^</code>）

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + S` | 保存当前内容 |
| `Esc` | 关闭弹出菜单/对话框 |
| 双击菜单项 | 内联重命名 |

### 数据备份

点击工具栏「📦 备份知识库」按钮（仅 Admin 可见），系统将打包所有数据为 ZIP 文件并提供下载。普通用户无备份权限。

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
