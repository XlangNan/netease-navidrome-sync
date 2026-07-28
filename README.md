# 网易云 → Navidrome 音乐库工具箱

一套配合 [Navidrome](https://www.navidrome.org/) 自建音乐库使用的 Web 小工具,一条 `docker compose up -d`
就能把全部功能跑起来。

## 功能一览

| 功能 | 说明 |
|---|---|
| 🎵 歌单同步 | 免登录读取你网易云账号下的公开歌单,勾选后自动匹配 Navidrome 库里的歌曲并创建播放列表 |
| 🖼️ 歌手头像 | 从 Navidrome 读取歌手列表,搜索并下载头像,配合 Navidrome 的 `ArtistImageFolder` 功能显示 |
| 💿 封面/歌词刮削 | 递归扫描音乐文件夹,把专辑封面嵌入音频文件、歌词存成同名 `.lrc`,支持网易云 / QQ音乐 / 酷我音乐三个数据源 |
| 👀 自动监控新文件 | 常驻监控指定目录,新歌曲文件一写入完成就自动刮削封面/歌词,不用手动操作 |

## 架构

```
┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  netease-api │     │  meting-api   │     │  sync-tool   │
│ (网易云代理)  │◄────┤ (QQ音乐/酷我) │◄────┤ (本体 + 网页) │
└──────────────┘     └───────────────┘     └──────┬───────┘
                                                     │
                                    ┌────────────────┼────────────────┐
                                    ▼                                 ▼
                            ┌───────────────┐                ┌───────────────┐
                            │   Navidrome   │                │  音乐文件目录  │
                            │ (Subsonic API)│                │ (读写挂载)     │
                            └───────────────┘                └───────────────┘
```

- `netease-api`:[Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi),网易云数据源
- `meting-api`:[metowolf/Meting-API](https://github.com/metowolf/Meting-API),QQ音乐/酷我音乐数据源
- `sync-tool`:本项目本体,Node.js + Express 后端 + 原生 HTML/JS 前端,不依赖任何前端框架

## 快速开始

需要 Docker 和 Docker Compose。

```bash
git clone <你的仓库地址>
cd netease-navidrome-sync
```

编辑 `docker-compose.yml`,把这处换成你自己的实际路径:

```yaml
volumes:
  - /volume1/music:/music   # 换成你实际存放音乐文件的路径
```

然后:

```bash
docker compose up -d --build
```

浏览器打开 `http://<你的服务器地址>:3001` 即可使用。所有配置(网易云 UID、Navidrome 账号等)填一次后会存在浏览器
`localStorage` 里,不用每次重填。

---

## 功能详解

### 1. 歌单同步

**免登录**,直接用你的网易云数字 UID 读取公开歌单列表。

1. 打开首页,填网易云 API 地址(默认自动预填,内部服务地址)和你的 UID
   (打开网易云个人主页,地址栏 `?id=` 后面那串数字)
2. 点「加载我的歌单」,勾选要同步的歌单(支持多选)
3. 填 Navidrome 服务器地址/账号/密码
4. 建议先勾「仅预览」跑一遍确认匹配效果,再正式同步创建播放列表

**匹配逻辑**:
- 精确匹配:歌名+歌手归一化后完全一致(忽略括号备注、标点、大小写)
- 模糊匹配:歌名相似度 × 0.7 + 歌手相似度 × 0.3,达到 0.8 以上视为匹配
- 都不满足则跳过,不会创建到播放列表里

**关于登录风控**:网易云近期对第三方客户端的"登录"行为风控较严,扫码/密码登录都有被判定异常甚至临时冻结账号的
风险。本工具默认完全不走登录流程,只用公开的 UID 查询接口,不受此影响。如果你有歌单被设为"隐私"、
一定要同步,可以在高级选项里手动填一次登录 Cookie,但这属于你自己承担风险的操作,不建议长期使用。

### 2. 歌手头像

从 Navidrome 读取歌手列表,搜索候选头像(网易云同名歌手),你确认后下载保存。

1. 打开「歌手头像」页,填 Navidrome 配置,点「加载歌手列表」
2. 歌手多的话先点「自动匹配未保存的歌手」——只有**精确同名且唯一**的候选才会自动保存,
   重名或者搜不到的会跳过,不瞎猜
3. 剩下的手动处理:点开某个歌手,可以改关键词重新搜、切百度/必应图片搜索(跳转过去自己找图再贴链接回来保存)
4. 支持按名字过滤搜索,大库(1000+ 歌手)也能快速定位

保存的图片存在 `artist-images/` 目录,需要额外把这个目录也挂载给 Navidrome 并设置环境变量才能显示,
具体做法见下面「让 Navidrome 显示歌手头像」。

### 3. 封面 / 歌词刮削

**完全独立于 Navidrome**,不需要 Navidrome 账号,直接递归扫描你挂载的音乐文件夹本身,
歌名/歌手信息从文件自带的 ID3/Vorbis 标签读取(缺失时尝试从文件名猜,比如"歌手 - 歌名.mp3")。

> ⚠️ **会直接修改你的音频文件和目录内容,正式批量跑之前请务必先备份。**

三种使用方式:

- **手动挑选**:加载歌曲列表,按名字搜索/按"缺封面或歌词"筛选,勾选后批量处理,也可以每条单独手动搜索确认
- **自动扫描整个目录**:不挑了,选定目录整个递归跑一遍
- **自动监控新文件**:常驻监控指定目录,新文件写入完成后自动处理(见下面单独说明)

数据源优先级:**网易云 → QQ音乐 → 酷我音乐**,依次尝试,只要一个源给出精确匹配就用。只有精确匹配才自动处理,
模糊匹配的歌曲会留在「需要人工确认」列表里等你手动选。

### 4. 自动监控新文件

常驻进程盯着你指定的目录(用系统级文件事件通知,不是轮询扫描,不吃 CPU 也不会随时间攒内存),
有新歌曲文件写入完成后自动跑封面/歌词刮削。

- `docker-compose.yml` 里 `WATCH_AUTO_START=true` 默认开启,容器启动就生效,不用手动点
- 只处理"监控开始之后新出现"的文件,已有的歌曲不受影响(那是前面两种扫描方式的事)
- 会等文件真正写完(5 秒内没有变化)才处理,不会处理到拷贝一半的文件
- 网页上「方式三」区域可以看实时状态、已处理数量、最近处理记录,也支持手动开关和临时指定其他目录
- 实测内存占用约 80MB,`docker-compose.yml` 里设了 512MB 硬上限兜底

### 让 Navidrome 显示歌手头像

歌手头像存在 sync-tool 容器的一个目录里,需要让 Navidrome 也能访问同一批文件:

1. 找到 `artist-images` 文件夹在宿主机上的实际路径(和 `docker-compose.yml` 同一目录下)
2. 在 **Navidrome 自己的** `docker-compose.yml` 里加一条 volume 和两个环境变量:

```yaml
services:
  navidrome:
    volumes:
      - /你的路径/netease-navidrome-sync/artist-images:/artist-images:ro
    environment:
      ND_ARTISTIMAGEFOLDER: /artist-images
      ND_ARTISTARTPRIORITY: "artist.*, album/artist.*, image-folder, external"
```

3. `docker compose up -d` 重启 Navidrome 即可

`ArtistImageFolder` 是 Navidrome 较新版本才支持的功能,版本太旧的话升级一下镜像。

---

## 配置项参考

`docker-compose.yml` 里 `sync-tool` 服务支持的环境变量:

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3001` | 网页服务端口 |
| `DEFAULT_NETEASE_BASE` | - | 网易云 API 地址,会自动预填到页面上 |
| `DEFAULT_METING_BASE` | - | Meting-API 地址(QQ音乐/酷我音乐),留空则只用网易云 |
| `ARTIST_IMAGE_DIR` | `/data/artist-images` | 歌手头像保存目录(容器内路径) |
| `MUSIC_LIBRARY_DIR` | `/music` | 音乐库挂载路径(容器内路径),封面/歌词刮削和监控都基于这个目录 |
| `WATCH_AUTO_START` | `false` | 是否在容器启动时自动开始监控新文件 |
| `WATCH_DIR` | 空(整个根目录) | 自动监控的目录,相对 `MUSIC_LIBRARY_DIR` |
| `WATCH_COVER` / `WATCH_LYRICS` | `true` | 自动监控时是否刮封面 / 歌词 |
| `ACCESS_PASSWORD` | 空(不需要密码) | 设置后访问网页/接口都需要密码(浏览器原生弹窗,账号随便填) |
| `DINGTALK_WEBHOOK` | 空(不发通知) | 钉钉机器人 webhook 完整地址(含 `access_token`) |
| `DINGTALK_SECRET` | 空 | 钉钉机器人"加签"安全设置对应的密钥,用其他安全方式则留空 |
| `NOTIFY_PLAYLIST_SYNC` | `true` | 歌单同步完成后是否发钉钉通知 |
| `NOTIFY_SCRAPE_DONE` | `true` | 封面/歌词刮削任务完成后是否发钉钉通知 |
| `NOTIFY_WATCH_NEW_FILE` | `true` | 自动监控处理新文件后是否发钉钉通知(每个文件一条) |

---

---

## 外部访问密码保护

如果把 `3001` 端口暴露到公网(路由器端口转发、反代等),强烈建议设置 `ACCESS_PASSWORD`,不然任何人都能访问到
你的网易云账号信息、Navidrome 密码、音乐库文件操作等功能。

```yaml
environment:
  - ACCESS_PASSWORD=设一个自己的密码
```

设置后访问网页会弹出浏览器原生的账号密码框,**账号随便填,密码填这里配置的值**。只在局域网内用、
不打算暴露到公网的话,这个可以不用设置,留空就跟以前一样直接访问。

## 钉钉机器人通知

在钉钉群里加一个"自定义机器人",能收到:歌单同步完成、封面/歌词刮削任务完成、自动监控处理新文件这三类通知。

### 获取 webhook 地址

1. 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义
2. 安全设置三选一:**自定义关键词**(消息里要包含设的关键词,比较简单,但要求发送的文字必须带上那个关键词,
   跟本工具默认发的内容对不上的话收不到,不太推荐)、**IP 地址(段)**(填你 NAS 的公网出口 IP)、
   **加签**(推荐,生成一个密钥,本工具会自动算签名,不用改消息内容)
3. 复制生成的 Webhook 地址(形如 `https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx`)

### 配置到 docker-compose.yml

```yaml
environment:
  - DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx
  # 如果安全设置选的是"加签",把生成的密钥(以 SEC 开头)填这里;其他两种安全方式留空
  - DINGTALK_SECRET=SECxxxxxxxxxxxxxxxx
```

三个通知开关(`NOTIFY_PLAYLIST_SYNC`/`NOTIFY_SCRAPE_DONE`/`NOTIFY_WATCH_NEW_FILE`)默认都是开的,
不想要某一类通知就单独设成 `false`。自动监控这个通知是**每个文件处理完发一条**,如果你的库经常
批量涌入很多新文件,可能会比较吵,不想要的话把 `NOTIFY_WATCH_NEW_FILE` 关掉,只保留任务汇总类的通知。

---

## 常见问题

**Q: 端口冲突,提示 `port is already allocated`**
把 `docker-compose.yml` 里 `sync-tool` 的 `ports` 映射改一下宿主机那一侧,例如 `"3011:3001"`。

**Q: 创建播放列表报 `414 Request-URI Too Long`**
已修复,现在走 POST 请求体传参,不受 URL 长度限制。如果你是很久之前的版本,更新到最新代码即可。

**Q: 扫码登录时提示"环境异常"**
网易云对第三方客户端登录行为的风控,不是本工具或部署环境的问题。本工具默认走免登录的 UID 方式,不受影响。

**Q: QQ音乐/酷我音乐搜不到东西、封面预览不显示**
检查 `meting-api` 服务是否配置了 `METING_URL` 环境变量(必须配置,否则生成的封面/歌词链接是坏的)。

**Q: 每次改完代码,`docker compose up -d` 好像没生效**
需要显式重新构建镜像:

```bash
docker compose down
docker compose build --no-cache sync-tool
docker compose up -d
```

---

## 已知限制

- 简繁体转换未处理,网易云是简体、Navidrome 元数据是繁体的情况可能匹配失败
- 同名同艺人但不同版本(Live 版、伴奏版等)可能匹配到错误版本,建议处理后人工抽查
- QQ音乐、酷我音乐走的是第三方逆向接口(Meting-API),稳定性依赖上游服务,可能随对方接口调整而失效

## 免责声明

本项目仅供个人自建音乐库场景下的技术学习和研究使用。它依赖的第三方数据源
([NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)、
[Meting-API](https://github.com/metowolf/Meting-API))均为公开的开源项目,本项目与网易云音乐、
QQ音乐、酷我音乐官方没有任何关系,不对这些第三方接口的可用性和稳定性负责。

请遵守当地法律法规以及各音乐平台的服务条款,搜集到的封面、歌词、头像等素材仅限个人使用,
不要用于任何商业用途或侵犯版权的行为。使用本项目产生的一切后果由使用者自行承担。

## License

[MIT](LICENSE)
