# 陨石样本编目台（sologsb-1125 / gbmeteorite）

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21825>

停止（镜像保留）：

```bash
docker compose down
```

## 项目简介

面向陨石收藏者与标本室的纯前端单页应用：把样本、发现记录、切片制样与检测数值整理成本地可检索档案。
核心动作是登记样本与发现地坐标、挂接切片、录入电子探针数值并给出分类建议。

- 纯前端 SPA：**无后端、无数据库服务、无外部 API**
- 所有数据保存在浏览器本地：业务数据走 **IndexedDB（Dexie，库名 `gbmeteorite-db`）**，表单草稿走 **localStorage**
- 容器无状态，不挂载任何命名卷；换浏览器即换档案库

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript 5.7 |
| 构建 | Vite 6（`build` 脚本为 `tsc -b && vite build`，类型检查零错误） |
| UI 组件库 | MUI（@mui/material 6 + @mui/icons-material） |
| 状态管理 | Zustand（`sampleStore` 业务数据 / `uiStore` 筛选与提示） |
| 路由 | React Router 6（BrowserRouter + nginx `try_files` 兜底） |
| 本地存储 | Dexie 4（IndexedDB）+ localStorage（草稿） |
| 部署 | 多阶段 Dockerfile：node:20-alpine 构建 → nginx:alpine 托管 |

## 核心页面

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 样本总览：卡片流 + 分类/化学群/重量区间筛选与排序，缺坐标或缺切片显示角标 | MeteoriteSample |
| `/samples/new` | 样本登记：编号生成、分类化学群、重量、存放位置，可补录发现地坐标并即时校验 | MeteoriteSample、FindRecord |
| `/samples/:id` | 样本详情：基本信息 + 发现地摘要 + 切片列表 + 分析记录，可就地新增；版本更新后可在页内重新认定 | 四个模型 |
| `/sections` | 切片库：按厚度与矿物占比筛选，回跳样本，批量标注质量 | ThinSection、MeteoriteSample |
| `/analysis` | 分析检测：录入 Fa / Fs / Ni / 铁纹石带宽，实时分类建议；原结论与新结论并排展示并可复核 | AnalysisRecord、MeteoriteSample |
| `/locations` | 发现地分布：SVG 网格按经纬度打点、按分类着色、点选弹出样本清单 | FindRecord、MeteoriteSample |
| `/thresholds` | 阈值版本：新区间先存草稿，发布时原子绑定全部样本/切片/检测记录；历史版本只读 | ThresholdVersion |

## 阈值版本化（不可改的历史区间）

探针分类阈值（Fa / Fs / Ni / 铁纹石带宽，以及分类判定参数）按 **ThresholdVersion** 管理：

- **发布即冻结**：已发布版本的区间与规则永不可改；季度调整只能“以当前版本为蓝本 → 存草稿 → 发布新版本”。
- **草稿不生效**：草稿可反复保存/丢弃，期间所有页面仍按当前版本出结论。
- **原子共同绑定**：发布在单个 IndexedDB 事务内完成——写入新版本行 → 全部样本、切片、检测记录共同绑定同一版本 → 推进 `meta.current` → 删除草稿行。任一步失败整体回滚，原版本继续生效、草稿保留。
- **并发互斥**：草稿行是唯一临界资源。两个页面/标签同时提交发布时，IDB 读写事务串行化，第二个发布会读不到草稿行而抛 `PublishConflictError` 并整体回滚，**只有一份生效**。
- **受影响建议立即失效**：发布时按新版本逐条重算，结论（分类/置信度）变化的检测记录置 `stale`，其**原结论冻结在 `frozenAdvice`（带历史版本号）**；页面把“原结论 vs 新结论”并排展示，由人选择“采用新结论重新认定”或“保留原结论”。样本分类不会被自动改写，仅给出建议并进入“待重新认定”。
- **旧数据回填**：v4 迁移时，没有版本号的历史检测记录按**最早区间 v1（基线）**回填版本并冻结结论，状态置 `pending-review`（待核对）。
- **跨标签同步**：发布/复核通过 `BroadcastChannel` 通知其它已打开页面自动重载。

逻辑校验脚本（fake-indexeddb，50 项断言，覆盖回填 / 草稿 / 发布绑定 / 失效 / 重新认定 / 回滚 / 并发互斥）：

```bash
cd frontend && npm run verify:versioning
```

## 数据模型（`src/types/` 独立文件）

- `types/sample.ts` — **MeteoriteSample**：id、样本编号、总重量 g、分类、化学群、风化等级 W0–W4、发现/坠落、存放位置
- `types/find.ts` — **FindRecord**：id、关联样本、地名、国家地区、经纬度、坐标来源（GPS/文献）、发现环境、发现者
- `types/section.ts` — **ThinSection**：id、切片编号、关联样本、厚度 μm、制样方式、矿物占比、显微照片清单、`thresholdVersionId`（发布时共同绑定）
- `types/analysis.ts` — **AnalysisRecord**：id、关联样本或切片、方法、橄榄石 Fa、辉石 Fs、Ni wt%、铁纹石带宽 mm、检测日期、`thresholdVersionId`、`frozenAdvice`（冻结结论+版本）、`reviewState`（confirmed/stale/pending-review）
- `types/threshold.ts` — **ThresholdVersion**：版本号、状态（draft/published）、四个区间 + 分类判定参数快照、序号；另有单例 `MetaRow` 记录 current / sequence / revision

## 目录结构

```
sologsb-1125/
├── docker-compose.yml
├── .env / .env.example
├── README.md
└── frontend/
    ├── Dockerfile          # 多阶段：node:20-alpine → nginx:alpine
    ├── nginx.conf          # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig*.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{sample,find,section,analysis}.ts
        ├── db/index.ts                 # Dexie 封装与 v1→v3 升级迁移
        ├── stores/{sampleStore,uiStore}.ts
        ├── components/common/{SampleCard,Badge,FieldGroup,EmptyState,CoordinatePicker,AppShell}.tsx
        ├── hooks/{useSampleFilter,useLocalDraft,useRegionStats}.ts
        ├── pages/{Overview,New,Detail,Sections,Analysis,Locations}.tsx
        ├── router/index.tsx
        └── utils/{classify,format,geo}.ts
```

## 数据存储说明

- **库名**：`gbmeteorite-db`；表：`samples`、`finds`、`sections`、`analysis`、`thresholdVersions`、`meta`
- **版本迁移**：
  - v1 建 `samples` / `finds` / `sections`
  - v2 新增 `analysis` 表并加 `sampleId` 索引
  - v3 为 `samples` 补 `updatedAt` 字段并按 id 回填旧记录
  - v4 新增 `thresholdVersions` / `meta`；为 `samples` / `sections` / `analysis` 补 `thresholdVersionId`，为 `analysis` 补 `reviewState` 与冻结结论；无版本号的旧检测记录按最早区间 v1 回填并置“待核对”
- **关键目录新增**：`services/versionService.ts`（草稿/原子发布/并发互斥/重新认定）、`hooks/useThresholdVersion.ts`、`components/analysis/{AnalysisConclusion,ReviewBadges}.tsx`、`pages/Thresholds.tsx`、`scripts/verify-versioning.ts`
- **草稿**：`/samples/new` 与 `/analysis` 的表单草稿写入 localStorage（键前缀 `gbmeteorite:draft:`），切页自动恢复，提交后清理
- 首次打开会灌入 3 份演示样本、2 条发现记录、2 张切片与 2 条检测记录，便于直接体验筛选与打点

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `gbmeteorite` | Compose 项目名与容器名前缀 |
| `FRONTEND_PORT` | `21825` | 宿主端口，映射到容器 80 |
