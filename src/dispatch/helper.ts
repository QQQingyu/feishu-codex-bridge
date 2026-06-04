import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const TASK_STATUSES = new Set([
  'pending',
  'assigned',
  'running',
  'blocked',
  'reviewing',
  'accepted',
  'rework',
  'planned',
  'done',
  'failed',
]);

const RUNNABLE_STATUSES = new Set(['pending', 'assigned', 'rework', 'blocked', 'failed']);
const RESULT_STATUSES = new Set(['reviewing', 'accepted', 'done']);
const REVIEWABLE_STATUSES = new Set(['reviewing']);

const DEFAULT_PROJECTS_DIR = join(homedir(), '.openclaw', 'workspace', 'projects');
const boardLocks = new Map<string, Promise<void>>();
const BUSINESS_LINES = ['博物馆', '咖啡清吧', '餐饮', '房地产', '占星', '企业策划'] as const;
const QUALITY_REVIEW_DIMENSIONS = ['事实准确性', '逻辑完整性', '执行可行性', '表达质量', '遗漏风险', '方案影响'];
const RESULT_REQUIRED_SECTIONS = ['核心结论', '执行过程摘要', '产出或发现', '风险/阻塞', '下一步建议', '自动复核'];
const RESEARCH_KEYWORDS = ['调研', '研究', '政策', '市场', '数据', '竞品', '房地产'];
const PLAN_FIRST_KEYWORDS = ['需要计划确认', '复杂', '多阶段', '策划方案', '调研报告', '实施方案', '执行方案'];

interface ProjectBrief {
  businessLine: string;
  coreGoal: string;
  deliverables: string;
  milestones: string;
  references: string;
}

interface BusinessTemplate {
  title: string;
  items: string[];
}

const BUSINESS_TEMPLATES: Record<string, BusinessTemplate> = {
  博物馆: {
    title: '博物馆展览策划模板',
    items: [
      '展览主题与定位',
      '目标受众分析',
      '展览叙事线（故事结构、章节划分）',
      '观众动线设计',
      '展品清单与布展方案',
      '教育与公共活动规划',
      '国内外参考案例（至少3个）',
      '预算估算',
      '时间表与里程碑',
      '风险预判与应对',
    ],
  },
  房地产: {
    title: '房地产调研报告模板',
    items: [
      '研究主题与范围',
      '核心摘要（3-5句关键发现）',
      '关键数据表（指标/数值/来源/时间）',
      '政策与监管动态',
      '市场供需分析',
      '价格走势与趋势判断',
      '竞品/周边项目分析',
      '风险与不确定性',
      '信息来源清单',
      '研究员建议（标注为推测）',
    ],
  },
  企业策划: {
    title: '企业策划提案模板',
    items: [
      '项目背景与客户需求理解',
      '核心策略与创意方向',
      '执行方案（分阶段、可落地）',
      '时间节点与交付物清单',
      '预算框架',
      '预期效果与评估指标',
      '风险预判与备选方案',
      '团队分工（如适用）',
    ],
  },
  咖啡清吧: {
    title: '咖啡清吧产品/活动方案模板',
    items: [
      '方案主题与目标',
      '目标客群画像',
      '产品/活动内容详情',
      '视觉风格方向',
      '季节性与在地化考量',
      '成本估算',
      '推广渠道建议',
      '时间安排',
    ],
  },
  餐饮: {
    title: '餐饮策划模板',
    items: [
      '项目定位与目标',
      '客群画像与消费场景',
      '竞品分析',
      '菜单/产品策略',
      '选址分析（如适用）',
      '运营节奏规划',
      '品牌视觉方向',
      '预算与收益预估',
    ],
  },
  占星: {
    title: '占星内容模板',
    items: [
      '主题与切入角度',
      '占星术语与概念说明（确保准确）',
      '内容正文',
      '调性检查：神秘但不故弄玄虚，温暖有洞察',
    ],
  },
};

const PINYIN: Record<string, string> = {
  博: 'bo',
  物: 'wu',
  馆: 'guan',
  咖: 'ka',
  啡: 'fei',
  清: 'qing',
  吧: 'ba',
  餐: 'can',
  饮: 'yin',
  房: 'fang',
  地: 'di',
  产: 'chan',
  占: 'zhan',
  星: 'xing',
  企: 'qi',
  业: 'ye',
  策: 'ce',
  划: 'hua',
  项: 'xiang',
  目: 'mu',
  任: 'ren',
  务: 'wu',
  多: 'duo',
  对: 'dui',
  话: 'hua',
  调: 'diao',
  度: 'du',
  试: 'shi',
  验: 'yan',
  案: 'an',
  例: 'li',
  研: 'yan',
  究: 'jiu',
  资: 'zi',
  料: 'liao',
  文: 'wen',
  方: 'fang',
  复: 'fu',
  核: 'he',
  输: 'shu',
  出: 'chu',
  市: 'shi',
  场: 'chang',
  政: 'zheng',
  展: 'zhan',
  览: 'lan',
  运: 'yun',
  营: 'ying',
  活: 'huo',
  动: 'dong',
  测: 'ce',
};

export class DispatchError extends Error {}

export interface DispatchTask {
  id: string;
  title: string;
  status: string;
  instructions: string;
  sessionId?: string;
  assignedTo?: string;
  workerChatId?: string;
  supervisorChatId?: string;
  createdAt: string;
  updatedAt: string;
  output: string;
  error?: string;
  overreachFiles?: string[];
  review?: string;
  reviewFindings?: string[];
  plan?: string;
  planApproved?: boolean;
}

interface DispatchBoard {
  version: number;
  project: {
    name: string;
    slug: string;
    goal: string;
    createdAt: string;
    updatedAt: string;
  };
  tasks: DispatchTask[];
}

interface WorkerInfo {
  name: string;
  chatId: string;
  updatedAt: string;
}

type Workers = Record<string, WorkerInfo>;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

type SourceUrlCheck = (url: string) => boolean | Promise<boolean>;

export interface DispatchManagerOptions {
  projectsDir?: string;
  codexBin?: string;
  defaultCwd?: string;
  maxWorkers?: number;
  timeoutMs?: number;
  sourceUrlCheck?: SourceUrlCheck;
}

export interface HandleAgentCommandOptions {
  args: string;
  chatId: string;
  reply: (text: string) => Promise<void>;
  replyCard?: (card: object, fallback: string) => Promise<void>;
  sendToChat?: (chatId: string, text: string) => Promise<void>;
  sendCardToChat?: (chatId: string, card: object, fallback: string) => Promise<void>;
  codexBin?: string;
  cwd?: string;
  projectsDir?: string;
}

export class DispatchManager {
  readonly projectsDir: string;
  readonly codexBin: string;
  readonly defaultCwd: string;
  readonly maxWorkers: number;
  readonly timeoutMs: number;
  readonly sourceUrlCheck?: SourceUrlCheck;

  constructor(opts: DispatchManagerOptions = {}) {
    this.projectsDir = resolve(
      expandHome(opts.projectsDir ?? process.env.FEISHU_BRIDGE_PROJECTS_DIR ?? DEFAULT_PROJECTS_DIR),
    );
    this.codexBin = opts.codexBin ?? process.env.CODEX_BIN ?? 'codex';
    this.defaultCwd = resolve(expandHome(opts.defaultCwd ?? homedir()));
    this.maxWorkers = Math.max(
      1,
      Number(opts.maxWorkers ?? process.env.FEISHU_BRIDGE_AGENT_MAX_WORKERS ?? 3) || 3,
    );
    this.timeoutMs = Math.max(
      30_000,
      Number(opts.timeoutMs ?? process.env.FEISHU_BRIDGE_AGENT_TIMEOUT_MS ?? 600_000) ||
        600_000,
    );
    this.sourceUrlCheck = opts.sourceUrlCheck ?? (sourceUrlCheckEnabled() ? defaultSourceUrlCheck : undefined);
  }

  async createProject(name: string, goal = ''): Promise<{ name: string; slug: string; path: string }> {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new DispatchError('项目名称不能为空。');
    await mkdir(this.projectsDir, { recursive: true });
    const slug = await this.uniqueSlug(slugify(cleanName));
    const path = join(this.projectsDir, slug);
    await mkdir(path, { recursive: false });
    await mkdir(join(path, 'tasks'));
    await mkdir(join(path, 'progress'));
    await mkdir(join(path, 'outputs'));
    await mkdir(join(path, 'plans'));
    await mkdir(join(path, 'reviews'));
    await mkdir(join(path, 'worker_state'));
    await mkdir(join(path, 'worker_runs'));
    await mkdir(join(path, 'templates'));
    const now = nowText();
    const board: DispatchBoard = {
      version: 1,
      project: {
        name: cleanName,
        slug,
        goal: String(goal || '').trim(),
        createdAt: now,
        updatedAt: now,
      },
      tasks: [],
    };
    await writeBoard(path, board);
    await writeGovernanceFiles(path, board);
    const brief = projectBrief(cleanName, board.project.goal);
    const template = BUSINESS_TEMPLATES[brief.businessLine];
    await writeFile(
      join(path, 'project.md'),
      [
        `# ${cleanName}`,
        '',
        '## 项目立项',
        '',
        `项目名称：${cleanName}`,
        `业务线：${brief.businessLine}`,
        `核心目标：${brief.coreGoal}`,
        `交付物：${brief.deliverables}`,
        `关键节点：${brief.milestones}`,
        `参考方向：${brief.references}`,
        '',
        '## 业务线交付模板',
        '',
        template
          ? [`### ${template.title}`, '', ...template.items.map((item, index) => `${index + 1}. ${item}`)].join('\n')
          : '未识别业务线。请在项目名称里使用：博物馆 / 咖啡清吧 / 餐饮 / 房地产 / 占星 / 企业策划。',
        '',
        '## 质量复核标准',
        '',
        ...QUALITY_REVIEW_DIMENSIONS.map((item) => `- ${item}`),
        '',
        '## 运行约定',
        '',
        '- 主控对话负责拆解、分派、复核和合并。',
        '- 执行对话只处理被分配的单项任务。',
        '- 执行对话在 worker_runs/<task-id>/ 隔离目录内运行，只提交自己的 outputs/ 与 worker_state/ 文件。',
        '- task_board.json 是唯一可信任务状态源。',
        '- 09_dispatch_board.md 是主控可读看板，由系统从 task_board.json 同步生成。',
        '- 执行结果必须写入 outputs/ 后再进入复核。',
        '- 复杂任务先提交 plans/<task-id>-plan.md，经主控批准后再执行。',
        '- 主控验收必须检查结果完整性、索引状态、队列状态、越权写入风险和质量复核维度。',
        '- 材料不足必须写“无法判断”或“需要补充的信息”，不得自行脑补。',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(path, 'handoff.md'), `# ${cleanName} Handoff\n\n暂无主控复核记录。\n`, 'utf8');
    return { name: cleanName, slug, path };
  }

  async listProjects(): Promise<Array<{ name: string; slug: string; path: string; updatedAt: string }>> {
    await mkdir(this.projectsDir, { recursive: true });
    const entries = await readdir(this.projectsDir, { withFileTypes: true });
    const projects: Array<{ name: string; slug: string; path: string; updatedAt: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.projectsDir, entry.name);
      try {
        const board = await readBoard(path);
        projects.push({
          name: String(board.project?.name || entry.name),
          slug: String(board.project?.slug || entry.name),
          path,
          updatedAt: String(board.project?.updatedAt || ''),
        });
      } catch {
        // Ignore non-dispatch folders under the projects directory.
      }
    }
    projects.sort((a, b) => {
      const time = a.updatedAt.localeCompare(b.updatedAt);
      return time === 0 ? a.slug.localeCompare(b.slug) : time;
    });
    return projects;
  }

  async defaultProjectSlug(): Promise<string> {
    const projects = await this.listProjects();
    if (projects.length === 0) throw new DispatchError('还没有调度项目。先用 /agent new 项目名');
    const latest = projects[projects.length - 1];
    if (!latest) throw new DispatchError('还没有调度项目。先用 /agent new 项目名');
    return latest.slug;
  }

  async addTask(projectSlug: string, title: string, instructions: string): Promise<DispatchTask> {
    const projectPath = await this.projectPath(projectSlug);
    const cleanTitle = String(title || '').trim();
    const cleanInstructions = String(instructions || '').trim();
    if (!cleanTitle) throw new DispatchError('任务标题不能为空。');
    if (!cleanInstructions) throw new DispatchError('任务说明不能为空。');
    const { board, task } = await updateBoard(projectPath, (board) => {
      const id = nextTaskId(board);
      const now = nowText();
      const task: DispatchTask = {
        id,
        title: cleanTitle,
        status: 'pending',
        instructions: cleanInstructions,
        sessionId: '',
        createdAt: now,
        updatedAt: now,
        output: `outputs/${id}-result.md`,
      };
      board.tasks.push(task);
      board.project.updatedAt = now;
      return { board, task };
    });
    await writeFile(
      join(projectPath, 'tasks', `${task.id}.md`),
      [
        `# ${task.id} ${cleanTitle}`,
        '',
        `项目：${board.project.name}`,
        '状态：pending',
        `输出文件：outputs/${task.id}-result.md`,
        '',
        '## 任务说明',
        '',
        cleanInstructions,
        '',
        '## 执行边界',
        '',
        `- 只允许写入 outputs/${task.id}-result.md。`,
        `- 只允许写入 worker_state/${task.id}.json。`,
        `- 如任务标注需要计划确认，先由主控生成并批准 plans/${task.id}-plan.md。`,
        '- 不允许修改 task_board.json、09_dispatch_board.md、project.md、治理机制文件或其它任务文件。',
        '',
        '## 验收标准',
        '',
        '- 输出包含：核心结论、执行过程摘要、产出或发现、风险/阻塞、下一步建议、自动复核。',
        `- 自动复核必须覆盖：${QUALITY_REVIEW_DIMENSIONS.join('、')}。`,
        '- 调研类任务必须列来源和时间；单一来源信息必须标注“待验证”。',
        '- 主控验收时会检查越权写入风险和质量复核完整性。',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeWorkerState(projectPath, task, 'pending', '任务已登记，等待主控派发。');
    return task;
  }

  async runnableTaskIds(projectSlug: string): Promise<string[]> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    return board.tasks
      .filter((task) => isRunnableTask(task))
      .map((task) => task.id);
  }

  async getTask(projectSlug: string, taskId: string): Promise<DispatchTask> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    return { ...findTask(board, taskId) };
  }

  async planTask(projectSlug: string, taskId: string): Promise<{ task: DispatchTask; planFile: string }> {
    const projectPath = await this.projectPath(projectSlug);
    const { board, task } = await updateBoard(projectPath, (board) => {
      const task = findTask(board, taskId);
      if (task.status === 'running' || task.status === 'reviewing' || task.status === 'accepted' || task.status === 'done') {
        throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能提交执行计划。`);
      }
      task.status = 'planned';
      task.plan = `plans/${task.id}-plan.md`;
      task.planApproved = false;
      task.updatedAt = nowText();
      board.project.updatedAt = task.updatedAt;
      return { board, task: { ...task } };
    });
    const planFile = task.plan || `plans/${task.id}-plan.md`;
    await writeFile(
      join(projectPath, planFile),
      [
        `# ${task.id} ${task.title} 执行计划`,
        '',
        `项目：${board.project.name}`,
        `状态：planned`,
        `更新时间：${nowText()}`,
        '',
        '## 任务目标',
        '',
        task.instructions,
        '',
        '## 执行步骤',
        '',
        '1. 明确目标、边界、交付物和验收标准。',
        '2. 收集必要材料；调研类任务必须记录来源、机构、链接和时间。',
        '3. 按任务要求产出结果文件，结论先行，材料不足写“无法判断”或“需要补充的信息”。',
        '4. 按事实准确性、逻辑完整性、执行可行性、表达质量、遗漏风险、方案影响做自动复核。',
        '5. 提交到 outputs/ 后等待主控 `/agent review`。',
        '',
        '## 资源与前提',
        '',
        '- 使用项目已有材料和主控提供的任务说明。',
        '- 不修改主控文件、其它任务文件或用户无关文件。',
        '',
        '## 风险预判',
        '',
        '- 材料不足：在结果中明确列为阻塞，不自行脑补。',
        '- 来源不足：调研类任务必须标注待验证。',
        '',
        '## 主控确认',
        '',
        `- 批准命令：/agent approve ${task.id} ${board.project.slug}`,
        '',
      ].join('\n'),
      'utf8',
    );
    await appendProgress(projectPath, task.id, 'planned', `已生成执行计划：${planFile}`);
    return { task, planFile };
  }

  async approvePlan(projectSlug: string, taskId: string): Promise<DispatchTask> {
    const projectPath = await this.projectPath(projectSlug);
    const task = await updateBoard(projectPath, (board) => {
      const task = findTask(board, taskId);
      if (!task.plan) throw new DispatchError(`${task.id} 还没有执行计划。先用 /agent plan ${task.id} ${board.project.slug}`);
      if (task.status !== 'planned') {
        throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能批准计划。`);
      }
      task.status = task.assignedTo ? 'assigned' : 'pending';
      task.planApproved = true;
      task.updatedAt = nowText();
      board.project.updatedAt = task.updatedAt;
      return { ...task };
    });
    await appendProgress(projectPath, task.id, 'approved', '主控已批准执行计划。');
    return task;
  }

  async runTask(projectSlug: string, taskId: string, chatId = ''): Promise<DispatchTask> {
    const projectPath = await this.projectPath(projectSlug);
    const { board, task } = await updateBoard(projectPath, (board) => {
      const task = findTask(board, taskId);
      if (requiresPlan(task) && !task.planApproved) {
        throw new DispatchError(`${task.id} 需要先提交计划并由主控批准。用法：/agent plan ${task.id} ${board.project.slug}，再 /agent approve ${task.id} ${board.project.slug}`);
      }
      if (!isRunnableTask(task)) {
        throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能直接执行。`);
      }
      task.status = 'running';
      task.updatedAt = nowText();
      board.project.updatedAt = task.updatedAt;
      return { board, task: { ...task } };
    });
    await appendProgress(projectPath, task.id, 'running', '开始执行。');
    await writeWorkerState(projectPath, task, 'running', '主控已派发，执行对话开始处理。');
    const workerRunPath = join(projectPath, 'worker_runs', task.id);
    await prepareWorkerRun(projectPath, workerRunPath, board, task);
    const beforeSnapshot = await fileSnapshot(projectPath);

    const lastMessage = join(workerRunPath, 'progress', `${task.id}-last-message.md`);
    const args = [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--cd',
      workerRunPath,
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--output-last-message',
      lastMessage,
      workerPrompt(projectPath, workerRunPath, board, task, chatId),
    ];
    const result = await runProcess(this.codexBin, args, {
      cwd: workerRunPath,
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '无错误输出').slice(-1200);
      await markFailed(projectPath, task.id, detail);
      throw new DispatchError(`${task.id} 执行失败：${detail}`);
    }

    const sessionId = extractSessionId(result.stdout);
    const body = await readFile(lastMessage, 'utf8').catch(() => result.stdout);
    const outputPath = join(projectPath, 'outputs', `${task.id}-result.md`);
    const workerOutputPath = join(workerRunPath, 'outputs', `${task.id}-result.md`);
    const overreachFiles = await detectWorkerOverreach(projectPath, task.id, beforeSnapshot);
    const existingOutput = await readFile(outputPath, 'utf8').catch(() => '');
    if (!existingOutput.trim()) {
      const workerOutput = await readFile(workerOutputPath, 'utf8').catch(() => '');
      if (workerOutput.trim()) {
        await writeFile(outputPath, workerOutput, 'utf8');
      } else {
        await writeFile(
          outputPath,
          [
            `# ${task.id} ${task.title}`,
            '',
            `项目：${board.project.name}`,
            '状态：reviewing',
            `Codex session：${sessionId || '未捕获'}`,
            `更新时间：${nowText()}`,
            '',
            '## 执行结果',
            '',
            body.trim() || '执行完成，但没有生成正文。',
            '',
          ].join('\n'),
          'utf8',
        );
      }
    }

    const updated = await updateBoard(projectPath, (board) => {
      const updated = findTask(board, task.id);
      updated.status = 'reviewing';
      updated.sessionId = sessionId;
      updated.overreachFiles = overreachFiles;
      updated.updatedAt = nowText();
      board.project.updatedAt = updated.updatedAt;
      return { ...updated };
    });
    await writeWorkerState(projectPath, updated, 'submitted_for_review', '执行完成，等待主控验收。');
    await appendProgress(projectPath, task.id, 'reviewing', `执行完成，结果写入 outputs/${task.id}-result.md`);
    return updated;
  }

  async registerWorker(projectSlug: string, name: string, chatId: string): Promise<WorkerInfo> {
    const projectPath = await this.projectPath(projectSlug);
    const cleanName = normalizeWorkerName(name);
    if (!cleanName) throw new DispatchError('执行对话名称不能为空。');
    const workers = await readWorkers(projectPath);
    const now = nowText();
    workers[cleanName] = { name: cleanName, chatId: String(chatId || '').trim(), updatedAt: now };
    await writeWorkers(projectPath, workers);
    await appendProgress(projectPath, 'workers', 'worker', `登记执行对话 ${cleanName} -> ${workers[cleanName].chatId || 'unknown'}`);
    return workers[cleanName];
  }

  async assignTask(
    projectSlug: string,
    taskId: string,
    workerName: string,
    supervisorChatId = '',
  ): Promise<{ projectPath: string; board: DispatchBoard; task: DispatchTask; worker: WorkerInfo }> {
    const projectPath = await this.projectPath(projectSlug);
    const cleanWorkerName = normalizeWorkerName(workerName);
    if (!cleanWorkerName) throw new DispatchError('执行对话名称不能为空。');
    const workers = await readWorkers(projectPath);
    const worker = workers[cleanWorkerName];
    if (!worker?.chatId) {
      throw new DispatchError(
        `没有找到执行对话：${cleanWorkerName}。先在目标对话发 /agent worker ${cleanWorkerName} ${projectSlug}`,
      );
    }
    const { board, task } = await updateBoard(projectPath, (board) => {
      const task = findTask(board, taskId);
      if (!isRunnableTask(task)) {
        throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能分派。`);
      }
      task.status = 'assigned';
      task.assignedTo = worker.name;
      task.workerChatId = worker.chatId;
      task.supervisorChatId = String(supervisorChatId || '').trim();
      task.updatedAt = nowText();
      board.project.updatedAt = task.updatedAt;
      return { board, task };
    });
    await appendProgress(projectPath, task.id, 'assigned', `分派给 ${worker.name} (${worker.chatId})`);
    return { projectPath, board, task, worker };
  }

  async markTask(projectSlug: string, taskId: string, status: string): Promise<DispatchTask> {
    const normalized = String(status || '').trim().toLowerCase();
    if (!TASK_STATUSES.has(normalized)) {
      throw new DispatchError(`状态必须是：${[...TASK_STATUSES].sort().join(', ')}`);
    }
    const projectPath = await this.projectPath(projectSlug);
    const task = await updateBoard(projectPath, (board) => {
      const task = findTask(board, taskId);
      task.status = normalized;
      task.updatedAt = nowText();
      board.project.updatedAt = task.updatedAt;
      return { ...task };
    });
    await appendProgress(projectPath, task.id, normalized, '主控手动更新状态。');
    return task;
  }

  async reviewTask(projectSlug: string, taskId: string): Promise<{
    task: DispatchTask;
    status: string;
    findings: string[];
    reviewFile: string;
  }> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const task = findTask(board, taskId);
    if (!REVIEWABLE_STATUSES.has(task.status) && task.status !== 'accepted' && task.status !== 'rework') {
      throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能验收。`);
    }
    const outputRel = String(task.output || `outputs/${task.id}-result.md`);
    const outputPath = resolve(projectPath, outputRel);
    if (!outputPath.startsWith(`${projectPath}/`) && outputPath !== projectPath) {
      throw new DispatchError('任务结果路径不合法。');
    }
    const body = (await readFile(outputPath, 'utf8').catch(() => '')).trim();
    if (!body) throw new DispatchError(`${task.id} 还没有可读取的结果文件：${outputRel}`);

    const missingSections = RESULT_REQUIRED_SECTIONS.filter((section) => !body.includes(section));
    const missingReviewDimensions = QUALITY_REVIEW_DIMENSIONS.filter((item) => !body.includes(item));
    const findings: string[] = [];
    if (missingSections.length) findings.push(`缺少必要章节：${missingSections.join('、')}`);
    if (missingReviewDimensions.length) {
      findings.push(`自动复核缺少质量维度：${missingReviewDimensions.join('、')}`);
    }
    const sourceAssessment = requiresSources(board, task)
      ? await assessSources(body, this.sourceUrlCheck)
      : { ok: true, reason: '' };
    if (!sourceAssessment.ok) findings.push(sourceAssessment.reason);
    const overreachFiles = (task.overreachFiles ?? []).filter(Boolean);
    if (overreachFiles.length) findings.push(`发现越权写入风险：${overreachFiles.join('、')}`);
    const statusText = findings.length ? 'rework' : 'accepted';
    const reviewFile = `reviews/${task.id}-review.md`;
    const previousReviewFindings = task.reviewFindings ?? [];
    const duplicateReview =
      (task.status === statusText || task.status === 'accepted' || task.status === 'rework') &&
      task.review === reviewFile &&
      previousReviewFindings.length === findings.length &&
      previousReviewFindings.every((item, index) => item === findings[index]);
    await writeFile(
      join(projectPath, reviewFile),
      [
        `# ${task.id} 主控验收`,
        '',
        `项目：${board.project.name}`,
        `任务：${task.title}`,
        `验收结论：${statusText}`,
        `验收时间：${nowText()}`,
        '',
        '## 核验项',
        '',
        `- 结果文件：${body ? '通过' : '不通过'}`,
        `- 必要章节：${missingSections.length ? '不通过' : '通过'}`,
        `- 自动复核维度：${missingReviewDimensions.length ? '不通过' : '通过'}`,
        `- 调研来源：${requiresSources(board, task) ? (sourceAssessment.ok ? '通过' : '不通过') : '不适用'}`,
        `- 越权写入风险：${overreachFiles.length ? '不通过' : '通过'}`,
        '- 队列状态：已由主控更新到验收结论。',
        '',
        '## 质量维度',
        '',
        ...QUALITY_REVIEW_DIMENSIONS.map((item) => `- ${item}：${missingReviewDimensions.includes(item) ? '缺失' : '已覆盖'}`),
        '',
        '## 问题记录',
        '',
        findings.length ? findings.map((item) => `- ${item}`).join('\n') : '- 未发现阻塞问题。',
        '',
      ].join('\n'),
      'utf8',
    );
    const updated = await updateBoard(projectPath, (board) => {
      const task = findTask(board, taskId);
      task.status = statusText;
      task.review = reviewFile;
      task.reviewFindings = findings;
      task.updatedAt = nowText();
      board.project.updatedAt = task.updatedAt;
      return { ...task };
    });
    await writeWorkerState(projectPath, updated, statusText, '主控验收完成。');
    if (!duplicateReview) {
      await appendProgress(projectPath, task.id, statusText, `主控自动验收：${statusText === 'accepted' ? '通过。' : '需返工。'}`);
      await appendHandoff(projectPath, updated, statusText, reviewFile, findings);
    }
    return { task: updated, status: statusText, findings, reviewFile };
  }

  async taskResultText(projectSlug: string, taskId: string, maxChars = 2800): Promise<string> {
    const { task, text } = await this.taskResult(projectSlug, taskId, maxChars);
    return `任务：${task.id} ${task.title}\n状态：${task.status}\n结果文件：${task.output}\n\n${text}`;
  }

  async taskResult(
    projectSlug: string,
    taskId: string,
    maxChars = 2800,
  ): Promise<{ board: DispatchBoard; task: DispatchTask; text: string }> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const task = findTask(board, taskId);
    const outputRel = String(task.output || `outputs/${task.id}-result.md`);
    const outputPath = resolve(projectPath, outputRel);
    if (!outputPath.startsWith(`${projectPath}/`) && outputPath !== projectPath) {
      throw new DispatchError('任务结果路径不合法。');
    }
    const body = (await readFile(outputPath, 'utf8').catch(() => '')).trim();
    if (!body) throw new DispatchError(`${task.id} 还没有可读取的结果文件：${outputRel}`);
    const text =
      body.length > maxChars
        ? `${body.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n\n[结果过长，已截断]`
        : body;
    return { board, task, text };
  }

  async statusText(projectSlug = ''): Promise<string> {
    if (!projectSlug) {
      const projects = await this.listProjects();
      if (projects.length === 0) return '还没有调度项目。用法：/agent new 项目名';
      return `调度项目：\n${projects.slice(-8).map((p) => `- ${p.slug}：${p.name}`).join('\n')}`;
    }
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const counts: Record<string, number> = {};
    for (const task of board.tasks) counts[task.status] = (counts[task.status] || 0) + 1;
    const stats = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('，') || '无任务';
    const rows = board.tasks.slice(-10).map((task) => `- ${task.id} [${task.status}] ${task.title}`);
    return `项目：${board.project.name}\n目录：${projectPath}\n任务统计：${stats}\n${rows.length ? rows.join('\n') : '暂无任务'}`;
  }

  async statusCard(projectSlug: string): Promise<object> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    return agentBoardCard(projectPath, board);
  }

  async cleanWorkerRuns(projectSlug: string): Promise<{ removed: string[]; kept: string[] }> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const removed: string[] = [];
    const kept: string[] = [];
    for (const task of board.tasks) {
      const runPath = join(projectPath, 'worker_runs', task.id);
      if (!await exists(runPath)) continue;
      if (task.status === 'accepted' || task.status === 'done') {
        await rm(runPath, { recursive: true, force: true });
        removed.push(task.id);
      } else {
        kept.push(task.id);
      }
    }
    return { removed, kept };
  }

  async uniqueSlug(base: string): Promise<string> {
    const slug = base || 'project';
    let candidate = slug;
    let index = 2;
    while (await exists(join(this.projectsDir, candidate))) {
      candidate = `${slug}-${index}`;
      index++;
    }
    return candidate;
  }

  async projectPath(slug: string): Promise<string> {
    const clean = String(slug || '').trim() || await this.defaultProjectSlug();
    const path = resolve(this.projectsDir, clean);
    if (!path.startsWith(`${this.projectsDir}/`) && path !== this.projectsDir) {
      throw new DispatchError('项目 slug 不合法。');
    }
    if (!await exists(join(path, 'task_board.json'))) throw new DispatchError(`没有找到调度项目：${clean}`);
    return path;
  }
}

export async function handleAgentCommand(opts: HandleAgentCommandOptions): Promise<void> {
  const { args, chatId, reply, replyCard, sendToChat, sendCardToChat, codexBin, cwd, projectsDir } = opts;
  const manager = new DispatchManager({ codexBin, defaultCwd: cwd, projectsDir });
  const raw = String(args || '').trim();
  if (!raw) {
    await reply(agentHelp());
    return;
  }

  const [firstLine = '', ...bodyLines] = raw.split(/\r?\n/);
  const body = bodyLines.join('\n').trim();
  const parts = firstLine.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || 'status').toLowerCase();
  try {
    if (sub === 'help' || sub === '帮助') {
      await reply(agentHelp());
      return;
    }
    if (['new', 'start', 'project'].includes(sub)) {
      const name = parts.slice(1).join(' ').trim();
      if (!name) {
        await reply('用法：/agent new 项目名\n项目目标');
        return;
      }
      const project = await manager.createProject(name, body);
      await reply(
        `已创建调度项目。\n项目：${project.name}\nslug：${project.slug}\n目录：${project.path}\n下一步：/agent add 任务标题\n任务说明`,
      );
      return;
    }
    if (sub === 'list' || sub === 'projects') {
      await reply(await manager.statusText());
      return;
    }
    if (sub === 'status' || sub === 'board') {
      const projectSlug = parts[1] || await manager.defaultProjectSlug().catch(() => '');
      if (projectSlug && replyCard) {
        await replyCard(await manager.statusCard(projectSlug), await manager.statusText(projectSlug));
      } else {
        await reply(await manager.statusText(projectSlug));
      }
      return;
    }
    if (sub === 'worker' || sub === 'join') {
      if (!parts[1]) {
        await reply('用法：/agent worker 执行对话名 [项目slug]');
        return;
      }
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      const worker = await manager.registerWorker(projectSlug, parts[1], chatId);
      await reply(`已登记执行对话。\n名称：${worker.name}\n项目：${projectSlug}\nchat：${worker.chatId}\n等待主控用 /agent assign T-001 ${worker.name} ${projectSlug} 分派任务。`);
      return;
    }
    if (sub === 'add' || sub === 'task') {
      const title = parts.slice(1).join(' ').trim();
      if (!title || !body) {
        await reply('用法：/agent add 任务标题\n任务说明');
        return;
      }
      const projectSlug = await manager.defaultProjectSlug();
      const task = await manager.addTask(projectSlug, title, body);
      await reply(`已登记任务：${task.id} [${task.status}]\n标题：${task.title}\n项目：${projectSlug}\n任务文件：tasks/${task.id}.md`);
      return;
    }
    if (sub === 'run') {
      if (!parts[1]) {
        await reply('用法：/agent run T-001 或 /agent run all [项目slug]');
        return;
      }
      const target = parts[1].toUpperCase();
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      if (target === 'ALL') {
        const taskIds = (await manager.runnableTaskIds(projectSlug)).slice(0, manager.maxWorkers);
        if (taskIds.length === 0) {
          await reply(`项目 ${projectSlug} 没有可执行任务。`);
          return;
        }
        await reply(`已启动 ${taskIds.length} 个执行对话：${taskIds.join(', ')}\n完成后会回写 outputs/ 并通知主控复核。`);
        for (const taskId of taskIds) {
          void runAndNotify(manager, projectSlug, taskId, chatId, reply, replyCard, sendToChat, sendCardToChat);
        }
        return;
      }
      const task = await manager.getTask(projectSlug, target);
      if (!isRunnableTask(task)) {
        throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能直接执行。`);
      }
      await reply(`已启动执行对话：${target}\n完成后会回写 outputs/${target}-result.md 并通知主控复核。`);
      void runAndNotify(manager, projectSlug, target, chatId, reply, replyCard, sendToChat, sendCardToChat);
      return;
    }
    if (sub === 'plan') {
      if (!parts[1]) {
        await reply('用法：/agent plan T-001 [项目slug]');
        return;
      }
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      const plan = await manager.planTask(projectSlug, parts[1].toUpperCase());
      await reply(`已生成执行计划：${plan.task.id}\n计划文件：${plan.planFile}\n下一步：/agent approve ${plan.task.id} ${projectSlug}`);
      return;
    }
    if (sub === 'approve') {
      if (!parts[1]) {
        await reply('用法：/agent approve T-001 [项目slug]');
        return;
      }
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      const task = await manager.approvePlan(projectSlug, parts[1].toUpperCase());
      await reply(`已批准执行计划：${task.id}\n当前状态：${task.status}\n下一步：/agent run ${task.id} ${projectSlug}`);
      return;
    }
    if (sub === 'assign' || sub === 'send') {
      if (!parts[1] || !parts[2]) {
        await reply('用法：/agent assign T-001 执行对话名 [项目slug]');
        return;
      }
      const projectSlug = parts[3] || await manager.defaultProjectSlug();
      const assigned = await manager.assignTask(projectSlug, parts[1].toUpperCase(), parts[2], chatId);
      const text = assignmentMessage(assigned.projectPath, assigned.board, assigned.task);
      const card = agentAssignmentCard(assigned.projectPath, assigned.board, assigned.task);
      if (sendCardToChat) {
        await sendCardToChat(assigned.worker.chatId, card, text);
      } else if (sendToChat) {
        await sendToChat(assigned.worker.chatId, text);
      }
      const fallback = `已分派任务：${assigned.task.id}\n项目：${projectSlug}\n执行对话：${assigned.worker.name}\n目标 chat：${assigned.worker.chatId}\n${sendCardToChat || sendToChat ? '已推送到执行对话。' : '当前运行时未提供跨聊天发送能力。'}`;
      if (replyCard) {
        await replyCard(agentAssignResultCard(projectSlug, assigned.task, assigned.worker), fallback);
      } else {
        await reply(fallback);
      }
      return;
    }
    if (sub === 'review') {
      if (!parts[1]) {
        await reply('用法：/agent review T-001 [项目slug]');
        return;
      }
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      const review = await manager.reviewTask(projectSlug, parts[1].toUpperCase());
      const findings = review.findings.length
        ? review.findings.map((item) => `- ${item}`).join('\n')
        : '- 未发现阻塞问题。';
      await reply(`主控验收完成：${review.task.id} -> ${review.task.status}\n复核文件：${review.reviewFile}\n问题记录：\n${findings}`);
      return;
    }
    if (sub === 'result' || sub === 'show') {
      if (!parts[1]) {
        await reply('用法：/agent result T-001 [项目slug]');
        return;
      }
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      if (replyCard) {
        const result = await manager.taskResult(projectSlug, parts[1].toUpperCase());
        await replyCard(
          agentTaskReviewCard(projectSlug, result.board, result.task, result.text),
          await manager.taskResultText(projectSlug, parts[1].toUpperCase()),
        );
      } else {
        await reply(await manager.taskResultText(projectSlug, parts[1].toUpperCase()));
      }
      return;
    }
    if (sub === 'mark') {
      if (!parts[1] || !parts[2]) {
        await reply('用法：/agent mark T-001 accepted|rework|done [项目slug]');
        return;
      }
      const projectSlug = parts[3] || await manager.defaultProjectSlug();
      const task = await manager.markTask(projectSlug, parts[1].toUpperCase(), parts[2]);
      await reply(`已更新任务：${task.id} -> ${task.status}`);
      return;
    }
    if (sub === 'clean') {
      const projectSlug = parts[1] || await manager.defaultProjectSlug();
      const result = await manager.cleanWorkerRuns(projectSlug);
      await reply(
        [
          `已清理 ${result.removed.length} 个隔离执行目录。`,
          `项目：${projectSlug}`,
          `已清理：${result.removed.length ? result.removed.join('、') : '无'}`,
          `保留：${result.kept.length ? result.kept.join('、') : '无'}`,
        ].join('\n'),
      );
      return;
    }
    await reply(agentHelp());
  } catch (err) {
    await reply(`调度命令失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runAndNotify(
  manager: DispatchManager,
  projectSlug: string,
  taskId: string,
  chatId: string,
  reply: (text: string) => Promise<void>,
  replyCard: ((card: object, fallback: string) => Promise<void>) | undefined,
  sendToChat: ((chatId: string, text: string) => Promise<void>) | undefined,
  sendCardToChat: ((chatId: string, card: object, fallback: string) => Promise<void>) | undefined,
): Promise<void> {
  try {
    const task = await manager.runTask(projectSlug, taskId, chatId);
    const result = await manager.taskResult(projectSlug, task.id);
    const fallback = `调度任务已完成：${projectSlug}/${task.id}\n状态：${task.status}\n结果：${task.output}\n下一步：主控读取结果并复核。`;
    const card = agentTaskReviewCard(projectSlug, result.board, result.task, result.text);
    if (replyCard) {
      await replyCard(card, fallback);
    } else {
      await reply(fallback);
    }
    if (task.supervisorChatId && task.supervisorChatId !== chatId) {
      const supervisorText = `执行对话已完成任务：${projectSlug}/${task.id}\n状态：${task.status}\n结果：${task.output}\n下一步：/agent result ${task.id} ${projectSlug}`;
      if (sendCardToChat) {
        await sendCardToChat(task.supervisorChatId, card, supervisorText);
      } else if (sendToChat) {
        await sendToChat(task.supervisorChatId, supervisorText);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reply(`调度任务失败：${projectSlug}/${taskId}\n${message}`);
    await notifySupervisorRunFailed(manager, projectSlug, taskId, chatId, sendToChat, message);
  }
}

async function notifySupervisorRunFailed(
  manager: DispatchManager,
  projectSlug: string,
  taskId: string,
  chatId: string,
  sendToChat: ((chatId: string, text: string) => Promise<void>) | undefined,
  fallbackError: string,
): Promise<void> {
  if (!sendToChat) return;
  try {
    const task = await manager.getTask(projectSlug, taskId);
    if (!task.supervisorChatId || task.supervisorChatId === chatId) return;
    const error = String(task.error || fallbackError || '无错误输出').trim();
    await sendToChat(
      task.supervisorChatId,
      [
        `执行对话任务失败：${projectSlug}/${task.id}`,
        `状态：${task.status}`,
        `错误：${error}`,
        `下一步：/agent status ${projectSlug}`,
      ].join('\n'),
    );
  } catch {
    // Worker-side failure reply above must remain the primary observable error.
  }
}

function agentHelp(): string {
  return [
    '多对话调度命令：',
    '/agent new 项目名',
    '项目目标',
    '/agent add 任务标题',
    '任务说明',
    '/agent worker 执行对话名 [项目slug]',
    '/agent assign T-001 执行对话名 [项目slug]',
    '/agent plan T-001 [项目slug]',
    '/agent approve T-001 [项目slug]',
    '/agent run T-001',
    '/agent run all [项目slug]',
    '/agent status [项目slug]',
    '/agent result T-001 [项目slug]',
    '/agent review T-001 [项目slug]',
    '/agent mark T-001 accepted|rework|done [项目slug]',
    '/agent clean [项目slug]',
    '',
    '约定：主控负责分派和复核；执行对话在 worker_runs/<task-id>/ 隔离目录内处理被分配任务。',
  ].join('\n');
}

function assignmentMessage(projectPath: string, board: DispatchBoard, task: DispatchTask): string {
  return `你收到一个执行任务。\n项目：${board.project.name}\n项目 slug：${board.project.slug}\n项目目录：${projectPath}\n任务：${task.id} ${task.title}\n输出文件：${task.output || `outputs/${task.id}-result.md`}\n\n任务说明：\n${task.instructions}\n\n执行方式：\n/agent run ${task.id} ${board.project.slug}\n\n完成后主控会用：\n/agent review ${task.id} ${board.project.slug}`;
}

function workerPrompt(
  projectPath: string,
  workerRunPath: string,
  board: DispatchBoard,
  task: DispatchTask,
  chatId: string,
): string {
  return `你是 feishu-codex-bridge 多对话调度系统中的执行对话，不是主控。
只完成当前任务，不要改动其它任务，不要删除用户或其它执行对话的文件。
主控才可以更新 task_board.json、09_dispatch_board.md、reviews/、project.md 和治理机制文件。
你当前运行在隔离工作区：${workerRunPath}
项目根目录仅作为只读参考：${projectPath}
你只允许在当前隔离工作区内写入：outputs/${task.id}-result.md、worker_state/${task.id}.json。
不要直接写入项目根目录；主控会在执行结束后只导入你的 outputs/${task.id}-result.md。
完成后必须把结果写入指定输出文件，并在最终回复里给出简短完成摘要。
输出要结论先行，不写空话；材料不足时明确写“无法判断”或“需要补充的信息”。

飞书 chat_id：${chatId || 'unknown'}
项目：${board.project.name}
项目根目录：${projectPath}
当前隔离工作区：${workerRunPath}
任务ID：${task.id}
任务标题：${task.title}
任务说明：
${task.instructions}

必须写入结果文件：outputs/${task.id}-result.md
建议同步写入本地状态：worker_state/${task.id}.json，status=submitted_for_review。
结果文件必须包含：核心结论、执行过程摘要、产出或发现、风险/阻塞、下一步建议、自动复核。
自动复核必须覆盖：${QUALITY_REVIEW_DIMENSIONS.join('、')}。
调研类任务必须列来源和时间；单一来源信息必须标注“待验证”。`;
}

function runProcess(command: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolveProcess({ code: 124, stdout, stderr: `${stderr}\n执行超时` });
    }, opts.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ code: 127, stdout, stderr: err.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readBoard(projectPath: string): Promise<DispatchBoard> {
  try {
    return JSON.parse(await readFile(join(projectPath, 'task_board.json'), 'utf8')) as DispatchBoard;
  } catch {
    throw new DispatchError(`读取任务板失败：${projectPath}`);
  }
}

async function writeBoard(projectPath: string, board: DispatchBoard): Promise<void> {
  await mkdir(dirname(join(projectPath, 'task_board.json')), { recursive: true });
  const tmp = join(projectPath, `task_board.json.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(tmp, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  await rename(tmp, join(projectPath, 'task_board.json'));
  await refreshDispatchBoard(projectPath, board);
}

async function writeGovernanceFiles(projectPath: string, board: DispatchBoard): Promise<void> {
  await writeFile(
    join(projectPath, '07_上下文窗口治理机制.md'),
    [
      '# 07_上下文窗口治理机制',
      '',
      '## 角色分工',
      '',
      '- 主控对话：拆解任务、派发执行对话、读取状态、验收结果、更新看板、裁决是否返工或合并。',
      '- 执行对话：只处理被分配的单项任务，不抢主控职责，不改其它任务。',
      '- 文件系统：承载持久状态；对话上下文只承载当前执行所需信息。',
      '',
      '## 写入边界',
      '',
      '- 执行对话只允许写自己的 outputs/<task-id>-result.md 与 worker_state/<task-id>.json。',
      '- 主控系统独占写入 task_board.json、09_dispatch_board.md、reviews/、handoff.md。',
      '- 禁止执行对话修改 project.md、治理机制文件、其它任务文件或删除用户文件。',
      '',
      '## 验收规则',
      '',
      '- 复杂任务先生成 plans/<task-id>-plan.md，并经主控批准后执行。',
      '- 核验结果文件是否存在且包含必要章节。',
      '- 调研类任务核验信息来源清单，必须包含来源机构、链接和时间。',
      '- 核验 task_board.json 与 09_dispatch_board.md 的队列状态是否一致。',
      '- 核验是否存在越权写入风险；一旦发现，任务进入 rework。',
      '- 主控验收记录写入 reviews/<task-id>-review.md。',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(projectPath, 'templates', 'worker_startup_instruction.md'),
    [
      '# 执行对话启动指令模板',
      '',
      '你是执行对话，不是主控。',
      '',
      '项目：{project_name}',
      '任务ID：{task_id}',
      '任务标题：{task_title}',
      '',
      '## 任务说明',
      '',
      '{task_instructions}',
      '',
      '## 只允许写入',
      '',
      '- outputs/{task_id}-result.md',
      '- worker_state/{task_id}.json',
      '',
      '## 禁止写入',
      '',
      '- task_board.json',
      '- 09_dispatch_board.md',
      '- project.md',
      '- reviews/',
      '- 其它任务的 tasks/progress/outputs/worker_state 文件',
      '',
      '## 结果文件必须包含',
      '',
      '核心结论、执行过程摘要、产出或发现、风险/阻塞、下一步建议、自动复核。',
      '',
      '## 自动复核必须覆盖',
      '',
      QUALITY_REVIEW_DIMENSIONS.join('、'),
      '',
    ].join('\n'),
    'utf8',
  );
  await refreshDispatchBoard(projectPath, board);
}

async function refreshDispatchBoard(projectPath: string, board: DispatchBoard): Promise<void> {
  const rows = [
    '| 任务ID | 状态 | 标题 | 输出 | 复核 | 越权风险 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const task of board.tasks) {
    rows.push(
      `| ${task.id} | ${task.status} | ${String(task.title || '').replace(/\|/g, '/')} | ${task.output || ''} | ${task.review || ''} | ${(task.overreachFiles ?? []).length ? (task.overreachFiles ?? []).join('、') : '无'} |`,
    );
  }
  if (rows.length === 2) rows.push('| - | - | 暂无任务 | - | - | - |');
  await writeFile(
    join(projectPath, '09_dispatch_board.md'),
    [
      '# 09_dispatch_board',
      '',
      `项目：${board.project?.name || projectPath}`,
      `更新时间：${board.project?.updatedAt || nowText()}`,
      '',
      '这张看板由主控系统从 task_board.json 同步生成；执行对话不得直接修改。',
      '',
      ...rows,
      '',
    ].join('\n'),
    'utf8',
  );
}

async function writeWorkerState(projectPath: string, task: DispatchTask, statusText: string, note: string): Promise<void> {
  await mkdir(join(projectPath, 'worker_state'), { recursive: true });
  await writeFile(
    join(projectPath, 'worker_state', `${task.id}.json`),
    `${JSON.stringify({
      taskId: task.id,
      title: task.title,
      status: statusText,
      note,
      updatedAt: nowText(),
    }, null, 2)}\n`,
    'utf8',
  );
}

async function prepareWorkerRun(
  projectPath: string,
  workerRunPath: string,
  board: DispatchBoard,
  task: DispatchTask,
): Promise<void> {
  await mkdir(workerRunPath, { recursive: true });
  await mkdir(join(workerRunPath, 'outputs'), { recursive: true });
  await mkdir(join(workerRunPath, 'worker_state'), { recursive: true });
  await mkdir(join(workerRunPath, 'progress'), { recursive: true });
  const projectBrief = await readFile(join(projectPath, 'project.md'), 'utf8').catch(() => '');
  const taskBrief = await readFile(join(projectPath, 'tasks', `${task.id}.md`), 'utf8').catch(() => '');
  await writeFile(
    join(workerRunPath, 'README.md'),
    [
      `# ${task.id} isolated worker run`,
      '',
      `项目：${board.project.name}`,
      `项目根目录（只读参考）：${projectPath}`,
      `隔离工作区：${workerRunPath}`,
      '',
      '## 写入边界',
      '',
      `- 只写当前目录下的 outputs/${task.id}-result.md。`,
      `- 可写当前目录下的 worker_state/${task.id}.json。`,
      '- 不直接写项目根目录；主控只会导入隔离目录里的结果文件。',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(workerRunPath, 'project.md'),
    projectBrief.trim()
      ? `${projectBrief.trimEnd()}\n`
      : [`# ${board.project.name}`, '', `目标：${board.project.goal || '未填写'}`, ''].join('\n'),
    'utf8',
  );
  await writeFile(
    join(workerRunPath, 'task.md'),
    taskBrief.trim()
      ? `${taskBrief.trimEnd()}\n`
      : [`# ${task.id} ${task.title}`, '', task.instructions, ''].join('\n'),
    'utf8',
  );
}

async function fileSnapshot(projectPath: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = path.slice(projectPath.length + 1);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && !rel.includes('.tmp')) {
        const body = await readFile(path).catch(() => Buffer.from(''));
        snapshot[rel] = createHash('sha256').update(body).digest('hex');
      }
    }
  }
  await walk(projectPath);
  return snapshot;
}

async function detectWorkerOverreach(projectPath: string, taskId: string, before: Record<string, string>): Promise<string[]> {
  const after = await fileSnapshot(projectPath);
  const allowedPrefix = `worker_runs/${taskId}/`;
  return Object.entries(after)
    .filter(([rel, digest]) => before[rel] !== digest && !rel.startsWith(allowedPrefix))
    .map(([rel]) => rel)
    .sort();
}

async function updateBoard<T>(
  projectPath: string,
  update: (board: DispatchBoard) => T | Promise<T>,
): Promise<T> {
  const previous = boardLocks.get(projectPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const queued = previous.then(() => current, () => current);
  boardLocks.set(projectPath, queued);
  await previous;
  try {
    const board = await readBoard(projectPath);
    const result = await update(board);
    await writeBoard(projectPath, board);
    return result;
  } finally {
    release();
    if (boardLocks.get(projectPath) === queued) {
      boardLocks.delete(projectPath);
    }
  }
}

async function readWorkers(projectPath: string): Promise<Workers> {
  try {
    return JSON.parse(await readFile(join(projectPath, 'workers.json'), 'utf8')) as Workers;
  } catch {
    return {};
  }
}

async function writeWorkers(projectPath: string, workers: Workers): Promise<void> {
  const tmp = join(projectPath, `workers.json.tmp-${process.pid}`);
  await writeFile(tmp, `${JSON.stringify(workers, null, 2)}\n`, 'utf8');
  await rename(tmp, join(projectPath, 'workers.json'));
}

function findTask(board: DispatchBoard, taskId: string): DispatchTask {
  const normalized = String(taskId || '').trim().toUpperCase();
  const task = board.tasks.find((item) => item.id === normalized);
  if (!task) throw new DispatchError(`没有找到任务：${taskId}`);
  return task;
}

function isRunnableTask(task: DispatchTask): boolean {
  return RUNNABLE_STATUSES.has(task.status);
}

function hasReadableResult(task: DispatchTask): boolean {
  return RESULT_STATUSES.has(task.status);
}

function isReviewableTask(task: DispatchTask): boolean {
  return REVIEWABLE_STATUSES.has(task.status);
}

function requiresPlan(task: DispatchTask): boolean {
  if (task.planApproved) return false;
  const text = `${task.title}\n${task.instructions}`;
  return PLAN_FIRST_KEYWORDS.some((keyword) => text.includes(keyword));
}

function requiresSources(board: DispatchBoard, task: DispatchTask): boolean {
  const text = sourceRequirementText(`${board.project.name}\n${board.project.goal}\n${task.title}\n${task.instructions}`);
  return (
    RESEARCH_KEYWORDS.some((keyword) => text.includes(keyword)) ||
    /(案例调研|案例研究|参考案例|案例分析|案例资料)/.test(text)
  );
}

function sourceRequirementText(text: string): string {
  return String(text || '')
    .replace(/(?:不是|不属于|非|无需|不需要|不用|不做)(?:业务)?(?:调研|研究|政策研究|市场研究|数据研究|案例研究|案例调研|竞品分析|房地产调研)/g, '')
    .replace(/(?:不联网|无需联网|不读取外部资料|不查外部资料|不使用外部资料)/g, '');
}

async function assessSources(body: string, sourceUrlCheck?: SourceUrlCheck): Promise<{ ok: boolean; reason: string }> {
  const sourceSection = extractSourceSection(body);
  if (!sourceSection.trim()) {
    return {
      ok: false,
      reason: '调研类任务缺少信息来源清单：需包含来源机构、链接和时间；单一来源信息需标注“待验证”。',
    };
  }
  const sourceCount = countSourceEntries(sourceSection);
  if (sourceCount === 0) {
    return {
      ok: false,
      reason: '调研类任务的信息来源清单不完整：至少需要可识别的来源链接和发布时间/检索时间。',
    };
  }
  if (sourceCount === 1 && !/(待验证|仅单一来源|单一来源|⚠️)/.test(sourceSection)) {
    return {
      ok: false,
      reason: '调研类任务只有单一来源且未标注“待验证”：需补充第二来源，或明确标注该信息待验证。',
    };
  }
  if (sourceUrlCheck) {
    const unreachable = await unreachableSourceUrls(extractSourceUrls(sourceSection), sourceUrlCheck);
    if (unreachable.length) {
      return {
        ok: false,
        reason: `来源链接不可达：${unreachable.join('、')}`,
      };
    }
  }
  return { ok: true, reason: '' };
}

function extractSourceSection(body: string): string {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /(信息来源|来源清单|参考来源|资料来源|Sources?)/i.test(line));
  if (start === -1) return '';
  const section = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+\S/.test(line) && !/(信息来源|来源清单|参考来源|资料来源|Sources?)/i.test(line)) break;
    section.push(line);
  }
  return section.join('\n');
}

function countSourceEntries(sourceSection: string): number {
  const lines = sourceSection.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (!/(https?:\/\/|www\.)/i.test(line)) continue;
    if (!/(时间|日期|发布|检索|访问|\d{4}[-年/])/i.test(line)) continue;
    count += 1;
  }
  return count;
}

function extractSourceUrls(sourceSection: string): string[] {
  const urls = new Set<string>();
  for (const match of sourceSection.matchAll(/https?:\/\/[^\s，。）、)>\]]+/gi)) {
    urls.add(match[0].replace(/[,.，。]+$/, ''));
  }
  for (const match of sourceSection.matchAll(/(?:^|[\s，。])www\.[^\s，。）、)>\]]+/gi)) {
    urls.add(`https://${match[0].trim().replace(/[,.，。]+$/, '')}`);
  }
  return [...urls];
}

async function unreachableSourceUrls(urls: string[], sourceUrlCheck: SourceUrlCheck): Promise<string[]> {
  const unreachable: string[] = [];
  for (const url of urls) {
    let ok = false;
    try {
      ok = Boolean(await sourceUrlCheck(url));
    } catch {
      ok = false;
    }
    if (!ok) unreachable.push(url);
  }
  return unreachable;
}

function sourceUrlCheckEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.FEISHU_BRIDGE_AGENT_SOURCE_URL_CHECK || ''));
}

async function defaultSourceUrlCheck(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutMs = Math.max(
    1000,
    Number(process.env.FEISHU_BRIDGE_AGENT_SOURCE_URL_TIMEOUT_MS || 5000) || 5000,
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (head.ok || (head.status >= 300 && head.status < 400)) return true;
    if (head.status !== 405 && head.status !== 403) return false;
    const get = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    return get.ok || (get.status >= 300 && get.status < 400);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function nextTaskId(board: DispatchBoard): string {
  let max = 0;
  for (const task of board.tasks) {
    const m = String(task.id || '').match(/^T-(\d{3})$/);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

async function markFailed(projectPath: string, taskId: string, error: string): Promise<void> {
  const task = await updateBoard(projectPath, (board) => {
    const task = findTask(board, taskId);
    task.status = 'failed';
    task.error = String(error || '').slice(-1200);
    task.updatedAt = nowText();
    board.project.updatedAt = task.updatedAt;
    return { ...task };
  });
  await appendProgress(projectPath, task.id, 'failed', task.error ?? '');
}

async function appendProgress(projectPath: string, taskId: string, statusText: string, note: string): Promise<void> {
  const path = join(projectPath, 'progress', `${taskId}.md`);
  const old = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${old}- ${nowText()} [${statusText}] ${note}\n`, 'utf8');
}

async function appendHandoff(
  projectPath: string,
  task: DispatchTask,
  statusText: string,
  reviewFile: string,
  findings: string[],
): Promise<void> {
  const path = join(projectPath, 'handoff.md');
  const old = await readFile(path, 'utf8').catch(() => '# Handoff\n\n');
  const note = [
    '',
    `## ${nowText()} ${task.id} ${task.title}`,
    '',
    `- 状态：${statusText}`,
    `- 结果：${task.output}`,
    `- 复核：${reviewFile}`,
    `- 结论：${statusText === 'accepted' ? '可合并或归档。' : '需返工后重新验收。'}`,
    `- 问题：${findings.length ? findings.join('；') : '未发现阻塞问题。'}`,
    '',
  ].join('\n');
  await writeFile(path, `${old.trimEnd()}\n${note}`, 'utf8');
}

function extractSessionId(stdout: string): string {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const evt = JSON.parse(line) as { thread_id?: unknown; session_id?: unknown; sessionId?: unknown };
      const id = evt.thread_id || evt.session_id || evt.sessionId;
      if (typeof id === 'string' && id) return id;
    } catch {
      // Ignore non-Codex JSON lines.
    }
  }
  return '';
}

function slugify(value: string): string {
  const words: string[] = [];
  let ascii = '';
  for (const char of String(value || '').toLowerCase()) {
    if (/^[a-z0-9]$/.test(char)) {
      ascii += char;
      continue;
    }
    if (ascii) {
      words.push(ascii);
      ascii = '';
    }
    if (PINYIN[char]) words.push(PINYIN[char]);
  }
  if (ascii) words.push(ascii);
  return words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'project';
}

function normalizeWorkerName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function projectBrief(name: string, body: string): ProjectBrief {
  const text = `${name}\n${body || ''}`;
  const businessLine = BUSINESS_LINES.find((line) => text.includes(line)) ?? '未填写';
  return {
    businessLine,
    coreGoal: fieldValue(body, ['核心目标', '项目目标', '目标']) || String(body || '').trim() || '未填写',
    deliverables: fieldValue(body, ['交付物', '最终交付', '输出']) || '未填写',
    milestones: fieldValue(body, ['关键节点', '时间节点', '截止日期', '里程碑']) || '未填写',
    references: fieldValue(body, ['参考方向', '参考资料', '特殊要求']) || '未填写',
  };
}

function fieldValue(body: string, labels: string[]): string {
  const lines = String(body || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    for (const label of labels) {
      const re = new RegExp(`^(?:[-*]\\s*)?${escapeRegExp(label)}\\s*[：:]\\s*(.+)$`);
      const match = trimmed.match(re);
      if (match?.[1]?.trim()) return match[1].trim();
    }
  }
  return '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nowText(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return `${homedir()}${path.slice(1)}`;
  return path;
}

function shell(title: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    body: {
      elements: [
        { tag: 'markdown', content: `**${escapeMd(title)}**` },
        HR,
        ...elements,
      ],
    },
  };
}

function divMd(content: string): object {
  return { tag: 'markdown', content };
}

function actions(buttons: Array<{ text: string; value: Record<string, unknown>; style?: 'primary' | 'danger' | 'default' }>): object {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: buttons.map((spec) => ({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: spec.text },
          type: spec.style ?? 'default',
          behaviors: [{ type: 'callback', value: spec.value }],
        },
      ],
    })),
  };
}

const HR: object = { tag: 'hr' };

function agentBoardCard(projectPath: string, board: DispatchBoard): object {
  const counts: Record<string, number> = {};
  for (const task of board.tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  const rows = board.tasks.slice(-8);
  const elements: object[] = [
    divMd(`项目：**${escapeMd(board.project.name)}**\nslug：\`${escapeCode(board.project.slug)}\`\n目录：\`${escapeCode(projectPath)}\``),
    divMd(`任务统计：${Object.entries(counts).map(([k, v]) => `${escapeMd(k)}:${v}`).join('，') || '无任务'}`),
    HR,
  ];
  if (rows.length === 0) {
    elements.push(divMd('暂无任务。'));
  } else {
    for (const task of rows) {
      elements.push(divMd(`**${task.id}** [${escapeMd(task.status)}] ${escapeMd(task.title)}\n输出：\`${escapeCode(task.output)}\``));
      const buttons: Array<{ text: string; value: Record<string, unknown>; style?: 'primary' | 'danger' | 'default' }> = [
        { text: '任务板', value: { cmd: 'agent.status', arg: board.project.slug } },
      ];
      if (isRunnableTask(task)) {
        buttons.unshift({ text: '开始执行', value: { cmd: 'agent.run', arg: `${task.id} ${board.project.slug}` }, style: 'primary' });
      }
      if (task.status === 'planned') {
        buttons.unshift({ text: '批准计划', value: { cmd: 'agent.approve', arg: `${task.id} ${board.project.slug}` }, style: 'primary' });
      }
      if (hasReadableResult(task)) {
        buttons.unshift({ text: '查看结果', value: { cmd: 'agent.result', arg: `${task.id} ${board.project.slug}` } });
      }
      if (isReviewableTask(task)) {
        buttons.push(
          { text: '自动验收', value: { cmd: 'agent.review', arg: `${task.id} ${board.project.slug}` }, style: 'primary' },
          { text: '返工', value: { cmd: 'agent.mark', arg: `${task.id} rework ${board.project.slug}` }, style: 'danger' },
          { text: '归档完成', value: { cmd: 'agent.mark', arg: `${task.id} done ${board.project.slug}` } },
        );
      }
      elements.push(actions(buttons));
    }
  }
  return shell('多对话调度任务板', elements);
}

function agentAssignmentCard(projectPath: string, board: DispatchBoard, task: DispatchTask): object {
  return shell('执行任务', [
    divMd(`项目：**${escapeMd(board.project.name)}**\nslug：\`${escapeCode(board.project.slug)}\`\n目录：\`${escapeCode(projectPath)}\``),
    HR,
    divMd(`任务：**${task.id} ${escapeMd(task.title)}**\n状态：\`${escapeCode(task.status)}\`\n输出：\`${escapeCode(task.output)}\``),
    divMd(`任务说明：\n${escapeMd(task.instructions).slice(0, 1200)}`),
    actions([
      { text: '开始执行', value: { cmd: 'agent.run', arg: `${task.id} ${board.project.slug}` }, style: 'primary' },
      { text: '查看任务板', value: { cmd: 'agent.status', arg: board.project.slug } },
    ]),
  ]);
}

function agentAssignResultCard(projectSlug: string, task: DispatchTask, worker: WorkerInfo): object {
  return shell('任务已分派', [
    divMd(`任务：**${task.id} ${escapeMd(task.title)}**\n项目：\`${escapeCode(projectSlug)}\`\n执行对话：\`${escapeCode(worker.name)}\`\n目标 chat：\`${escapeCode(worker.chatId)}\``),
    actions([
      { text: '查看任务板', value: { cmd: 'agent.status', arg: projectSlug }, style: 'primary' },
    ]),
  ]);
}

function agentTaskReviewCard(projectSlug: string, board: DispatchBoard, task: DispatchTask, resultText: string): object {
  return shell('任务待复核', [
    divMd(`任务：**${task.id} ${escapeMd(task.title)}**\n项目：\`${escapeCode(projectSlug)}\`\n状态：\`${escapeCode(task.status)}\`\n输出：\`${escapeCode(task.output)}\``),
    HR,
    divMd(resultText.slice(0, 2500)),
    actions([
      { text: '自动验收', value: { cmd: 'agent.review', arg: `${task.id} ${board.project.slug}` }, style: 'primary' },
      { text: '返工', value: { cmd: 'agent.mark', arg: `${task.id} rework ${board.project.slug}` }, style: 'danger' },
      { text: '归档完成', value: { cmd: 'agent.mark', arg: `${task.id} done ${board.project.slug}` } },
      { text: '任务板', value: { cmd: 'agent.status', arg: board.project.slug } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
