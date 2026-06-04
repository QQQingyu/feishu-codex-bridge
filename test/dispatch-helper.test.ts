import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DispatchManager, handleAgentCommand } from '../src/dispatch/helper';

async function fakeCodex(path: string, result: string, threadId = '33333333-3333-3333-3333-333333333333'): Promise<string> {
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'while [ "$1" != "" ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    shift',
      `    printf '${result}\\n' > "$1"`,
      '  fi',
      '  shift || exit 0',
      'done',
      `printf '{"thread_id":"${threadId}"}\\n'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

describe('dispatch helper', () => {
  it('creates a project, runs a worker, and writes output for review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      maxWorkers: 2,
      timeoutMs: 30_000,
    });

    const project = await manager.createProject('【企业策划】多对话调度试验', '验证闭环');
    expect(project.slug).toBe('qi-ye-ce-hua-duo-dui-hua-diao-du-shi-yan');
    await stat(join(project.path, 'task_board.json'));
    await stat(join(project.path, 'tasks'));
    await stat(join(project.path, 'progress'));
    await stat(join(project.path, 'outputs'));
    await stat(join(project.path, 'plans'));
    await stat(join(project.path, 'reviews'));
    await stat(join(project.path, 'worker_state'));
    await stat(join(project.path, 'templates', 'worker_startup_instruction.md'));
    await expect(readFile(join(project.path, '07_上下文窗口治理机制.md'), 'utf8')).resolves.toMatch(/越权写入/);
    await expect(readFile(join(project.path, '09_dispatch_board.md'), 'utf8')).resolves.toMatch(/执行对话不得直接修改/);
    await expect(readFile(join(project.path, 'templates', 'worker_startup_instruction.md'), 'utf8')).resolves.toMatch(/outputs\/\{task_id\}-result.md/);
    const projectMd = await readFile(join(project.path, 'project.md'), 'utf8');
    expect(projectMd).toMatch(/## 项目立项/);
    expect(projectMd).toMatch(/业务线：企业策划/);
    expect(projectMd).toMatch(/交付物：未填写/);
    expect(projectMd).toMatch(/关键节点：未填写/);
    expect(projectMd).toMatch(/参考方向：未填写/);
    expect(projectMd).toMatch(/企业策划提案模板/);
    expect(projectMd).toMatch(/预期效果与评估指标/);

    const task = await manager.addTask(project.slug, '案例调研', '整理一个案例');
    expect(task).toMatchObject({ id: 'T-001', status: 'pending' });
    await expect(readFile(join(project.path, 'tasks', 'T-001.md'), 'utf8')).resolves.toMatch(/案例调研/);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: await fakeCodex(join(root, 'fake-codex'), 'worker result'),
      defaultCwd: root,
      maxWorkers: 2,
      timeoutMs: 30_000,
    });
    const result = await runner.runTask(project.slug, 'T-001', 'oc_worker');

    expect(result).toMatchObject({
      id: 'T-001',
      status: 'reviewing',
      sessionId: '33333333-3333-3333-3333-333333333333',
    });
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toMatch(/worker result/);
  });

  it('preserves worker-written output and returns it through result command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-preserve-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('worker preserve', '验证保留 worker 输出文件');
    await manager.addTask(project.slug, '输出保留', '写入结果文件');
    const fakePreserveCodex = join(root, 'fake-preserve-codex');
    await writeFile(
      fakePreserveCodex,
      [
        '#!/bin/sh',
        'mkdir -p outputs',
        "printf 'worker file result\\n' > outputs/T-001-result.md",
        'while [ "$1" != "" ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        "    printf 'short chat summary\\n' > \"$1\"",
        '  fi',
        '  shift || exit 0',
        'done',
        'printf \'{"thread_id":"44444444-4444-4444-4444-444444444444"}\\n\'',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakePreserveCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakePreserveCodex,
      defaultCwd: root,
    });
    await runner.runTask(project.slug, 'T-001', 'oc_worker');
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toBe('worker file result\n');

    const replies: string[] = [];
    await handleAgentCommand({
      args: `result T-001 ${project.slug}`,
      chatId: 'oc_test',
      codexBin: fakePreserveCodex,
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        replies.push(text);
      },
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/任务：T-001 输出保留/);
    expect(replies[0]).toMatch(/worker file result/);
  });

  it('runs workers in an isolated workspace and only imports the task result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-overreach-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('overreach detection', '验证越权写入检查');
    await manager.addTask(project.slug, '越权任务', '只应写输出文件');
    const fakeOverreachCodex = join(root, 'fake-overreach-codex');
    await writeFile(
      fakeOverreachCodex,
      [
        '#!/bin/sh',
        'mkdir -p outputs',
        "printf 'worker file result\\n' > outputs/T-001-result.md",
        "printf 'unauthorized edit\\n' > project.md",
        'while [ "$1" != "" ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        "    printf 'short chat summary\\n' > \"$1\"",
        '  fi',
        '  shift || exit 0',
        'done',
        'printf \'{"thread_id":"55555555-5555-5555-5555-555555555555"}\\n\'',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeOverreachCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakeOverreachCodex,
      defaultCwd: root,
    });
    const result = await runner.runTask(project.slug, 'T-001', 'oc_worker');

    expect(result.overreachFiles ?? []).not.toContain('project.md');
    await expect(readFile(join(project.path, 'project.md'), 'utf8')).resolves.not.toMatch(/unauthorized edit/);
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toBe('worker file result\n');
    await expect(readFile(join(project.path, 'worker_runs', 'T-001', 'project.md'), 'utf8')).resolves.toMatch(/unauthorized edit/);
  });

  it('reviews complete results and writes supervisor review records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-auto-review-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('auto review', '验证自动验收');
    await manager.addTask(project.slug, '完整结果', '写完整结果');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '可继续。',
        '',
        '## 执行过程摘要',
        '已完成。',
        '',
        '## 产出或发现',
        '有可用材料。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '主控合并。',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('accepted');
    expect(review.reviewFile).toBe('reviews/T-001-review.md');
    await expect(readFile(join(project.path, 'reviews', 'T-001-review.md'), 'utf8')).resolves.toMatch(/验收结论：accepted/);
    await expect(readFile(join(project.path, 'reviews', 'T-001-review.md'), 'utf8')).resolves.toMatch(/事实准确性/);
  });

  it('does not append duplicate progress and handoff records for repeated identical reviews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-review-idempotent-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('review idempotent', '验证重复验收不会重复追加记录');
    await manager.addTask(project.slug, '重复验收', '写完整结果并重复验收');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '可以验收。',
        '',
        '## 执行过程摘要',
        '已完成。',
        '',
        '## 产出或发现',
        '有结果。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '主控合并。',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    await manager.reviewTask(project.slug, 'T-001');
    await manager.reviewTask(project.slug, 'T-001');

    const progress = await readFile(join(project.path, 'progress', 'T-001.md'), 'utf8');
    const handoff = await readFile(join(project.path, 'handoff.md'), 'utf8');
    expect((progress.match(/\[accepted\]/g) ?? [])).toHaveLength(1);
    expect((handoff.match(/## .* T-001 重复验收/g) ?? [])).toHaveLength(1);
  });

  it('requires worker self-review against Huaring quality dimensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-review-rubric-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('quality rubric', '验证华荣质量复核');
    await manager.addTask(project.slug, '缺自动复核', '写完整业务正文但缺少自检');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '可继续。',
        '',
        '## 执行过程摘要',
        '已完成。',
        '',
        '## 产出或发现',
        '有可用材料。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '主控合并。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('rework');
    expect(review.findings.join('\n')).toMatch(/自动复核/);
    expect(review.findings.join('\n')).toMatch(/事实准确性/);
  });

  it('requires explicit plan approval before running tasks marked as plan-first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-plan-gate-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: await fakeCodex(join(root, 'fake-codex'), 'should not run'),
      defaultCwd: root,
    });
    const project = await manager.createProject('plan gate', '验证计划确认');
    await manager.addTask(project.slug, '复杂方案', '需要计划确认：拆解一个多阶段企业策划方案');

    await expect(manager.runTask(project.slug, 'T-001', 'oc_worker')).rejects.toThrow(/需要先提交计划并由主控批准/);

    const plan = await manager.planTask(project.slug, 'T-001');
    expect(plan.task.status).toBe('planned');
    await expect(readFile(join(project.path, 'plans', 'T-001-plan.md'), 'utf8')).resolves.toMatch(/## 执行步骤/);

    const approved = await manager.approvePlan(project.slug, 'T-001');
    expect(approved.status).toBe('pending');
    expect(approved.planApproved).toBe(true);
  });

  it('returns research outputs without source lists to rework', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-source-review-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('【房地产】市场调研', '核心目标：验证来源校验');
    await manager.addTask(project.slug, '市场调研', '整理政策和市场数据');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '市场有变化。',
        '',
        '## 执行过程摘要',
        '已整理。',
        '',
        '## 产出或发现',
        '发现一个趋势。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '继续跟进。',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('rework');
    expect(review.findings.join('\n')).toMatch(/信息来源/);
  });

  it('does not require source lists for local validation runbooks that are not research tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-validation-no-sources-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('【企业策划】真实按钮演练', '核心目标：验证飞书按钮链路');
    await manager.addTask(
      project.slug,
      '真实按钮执行链路验证',
      '这是一次飞书真实按钮链路演练，不是业务调研。不联网，不读取外部资料。',
    );
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '按钮链路验证报告已生成。',
        '',
        '## 执行过程摘要',
        '已按本地演练任务执行，未联网，未读取外部来源。',
        '',
        '## 产出或发现',
        '当前材料无法判断外部飞书事件载荷，只能记录本地执行结果。',
        '',
        '## 风险/阻塞',
        '需要补充的信息：线上服务日志可用于主控二次核验。',
        '',
        '## 下一步建议',
        '由主控读取 task_board.json 和服务日志确认真实点击链路。',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('accepted');
    expect(review.findings.join('\n')).not.toMatch(/信息来源|单一来源/);
  });

  it('returns single-source research outputs without pending-verification labels to rework', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-single-source-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('【房地产】市场调研单源', '核心目标：验证单源标注');
    await manager.addTask(project.slug, '政策调研', '整理政策数据');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '市场有变化。',
        '',
        '## 执行过程摘要',
        '已整理。',
        '',
        '## 产出或发现',
        '发现一个趋势。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '继续跟进。',
        '',
        '## 信息来源清单',
        '- 国家统计局，https://www.stats.gov.cn/，检索时间：2026-06-03',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('rework');
    expect(review.findings.join('\n')).toMatch(/单一来源/);
  });

  it('accepts single-source research outputs that explicitly mark the source as pending verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-single-source-pending-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('【房地产】市场调研单源待验证', '核心目标：验证单源标注');
    await manager.addTask(project.slug, '政策调研', '整理政策数据');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '市场有变化。',
        '',
        '## 执行过程摘要',
        '已整理。',
        '',
        '## 产出或发现',
        '发现一个趋势。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '继续跟进。',
        '',
        '## 信息来源清单',
        '- ⚠️ 待验证：国家统计局，https://www.stats.gov.cn/，检索时间：2026-06-03',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('accepted');
  });

  it('accepts research outputs with at least two source entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-two-sources-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('【房地产】市场调研双源', '核心目标：验证双源');
    await manager.addTask(project.slug, '政策调研', '整理政策数据');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '市场有变化。',
        '',
        '## 执行过程摘要',
        '已整理。',
        '',
        '## 产出或发现',
        '发现一个趋势。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '继续跟进。',
        '',
        '## 信息来源清单',
        '- 国家统计局，https://www.stats.gov.cn/，检索时间：2026-06-03',
        '- 自然资源部，https://www.mnr.gov.cn/，发布时间：2026-06-01',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('accepted');
  });

  it('returns research outputs with unreachable source URLs to rework when strict URL checks are enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-source-url-check-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      sourceUrlCheck: async (url) => !url.includes('bad.example'),
    });
    const project = await manager.createProject('【房地产】市场调研 URL 校验', '核心目标：验证链接可达性');
    await manager.addTask(project.slug, '政策调研', '整理政策数据');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '市场有变化。',
        '',
        '## 执行过程摘要',
        '已整理。',
        '',
        '## 产出或发现',
        '发现一个趋势。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '继续跟进。',
        '',
        '## 信息来源清单',
        '- 国家统计局，https://www.stats.gov.cn/，检索时间：2026-06-03',
        '- 错误来源，https://bad.example/not-found，检索时间：2026-06-03',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const review = await manager.reviewTask(project.slug, 'T-001');

    expect(review.task.status).toBe('rework');
    expect(review.findings.join('\n')).toMatch(/来源链接不可达/);
    expect(review.findings.join('\n')).toMatch(/bad\.example/);
  });

  it('appends accepted supervisor reviews into handoff records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-handoff-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('handoff review', '验证复核沉淀');
    await manager.addTask(project.slug, '可沉淀结果', '写完整结果');
    await writeFile(
      join(project.path, 'outputs', 'T-001-result.md'),
      [
        '## 核心结论',
        '可以归档。',
        '',
        '## 执行过程摘要',
        '已完成。',
        '',
        '## 产出或发现',
        '产出完整。',
        '',
        '## 风险/阻塞',
        '暂无。',
        '',
        '## 下一步建议',
        '合并。',
        '',
        '## 自动复核',
        '- 事实准确性：通过。',
        '- 逻辑完整性：通过。',
        '- 执行可行性：通过。',
        '- 表达质量：通过。',
        '- 遗漏风险：通过。',
        '- 方案影响：通过。',
        '',
      ].join('\n'),
      'utf8',
    );
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    await manager.reviewTask(project.slug, 'T-001');

    const handoff = await readFile(join(project.path, 'handoff.md'), 'utf8');
    expect(handoff).toMatch(/T-001 可沉淀结果/);
    expect(handoff).toMatch(/accepted/);
    expect(handoff).toMatch(/reviews\/T-001-review.md/);
  });

  it('turns incomplete review results into rework from /agent review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-review-command-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('review command', '验证验收命令');
    await manager.addTask(project.slug, '缺章节结果', '写不完整结果');
    await writeFile(join(project.path, 'outputs', 'T-001-result.md'), '只有一句结果。\n', 'utf8');
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const replies: string[] = [];
    await handleAgentCommand({
      args: `review T-001 ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        replies.push(text);
      },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/主控验收完成：T-001 -> rework/);
    expect(replies[0]).toMatch(/缺少必要章节/);
  });

  it('preserves task board updates when multiple workers finish concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-concurrent-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const project = await manager.createProject('concurrent workers', '验证并发任务板回写');
    await manager.addTask(project.slug, '并发任务 A', 'write result A');
    await manager.addTask(project.slug, '并发任务 B', 'write result B');

    const fakeConcurrentCodex = join(root, 'fake-concurrent-codex');
    await writeFile(
      fakeConcurrentCodex,
      [
        '#!/bin/sh',
        'sleep 0.1',
        'prompt="${@: -1}"',
        'case "$prompt" in',
        "  *T-001*) tid='T-001'; sid='11111111-1111-1111-1111-111111111111' ;;",
        "  *T-002*) tid='T-002'; sid='22222222-2222-2222-2222-222222222222' ;;",
        "  *) tid='unknown'; sid='00000000-0000-0000-0000-000000000000' ;;",
        'esac',
        'while [ "$1" != "" ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        '    printf "worker result %s\\n" "$tid" > "$1"',
        '  fi',
        '  shift || exit 0',
        'done',
        'printf \'{"thread_id":"%s"}\\n\' "$sid"',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeConcurrentCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakeConcurrentCodex,
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    await Promise.all([
      runner.runTask(project.slug, 'T-001', 'oc_worker_a'),
      runner.runTask(project.slug, 'T-002', 'oc_worker_b'),
    ]);

    const board = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(board.tasks).toMatchObject([
      {
        id: 'T-001',
        status: 'reviewing',
        sessionId: '11111111-1111-1111-1111-111111111111',
      },
      {
        id: 'T-002',
        status: 'reviewing',
        sessionId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
  });

  it('preserves failed task states when multiple workers fail concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-concurrent-fail-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const project = await manager.createProject('concurrent failed workers', '验证并发失败回写');
    await manager.addTask(project.slug, '失败任务 A', 'fail A');
    await manager.addTask(project.slug, '失败任务 B', 'fail B');

    const fakeFailingCodex = join(root, 'fake-failing-codex');
    await writeFile(
      fakeFailingCodex,
      [
        '#!/bin/sh',
        'sleep 0.1',
        'prompt="${@: -1}"',
        'case "$prompt" in',
        "  *T-001*) tid='T-001' ;;",
        "  *T-002*) tid='T-002' ;;",
        "  *) tid='unknown' ;;",
        'esac',
        'printf "worker failed %s\\n" "$tid" >&2',
        'exit 42',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeFailingCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakeFailingCodex,
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const results = await Promise.allSettled([
      runner.runTask(project.slug, 'T-001', 'oc_worker_a'),
      runner.runTask(project.slug, 'T-002', 'oc_worker_b'),
    ]);

    expect(results).toMatchObject([
      { status: 'rejected' },
      { status: 'rejected' },
    ]);
    const board = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(board.tasks).toMatchObject([
      {
        id: 'T-001',
        status: 'failed',
        error: expect.stringContaining('worker failed T-001'),
      },
      {
        id: 'T-002',
        status: 'failed',
        error: expect.stringContaining('worker failed T-002'),
      },
    ]);
  });

  it('assigns a task to a registered worker chat and sends an interactive assignment card', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-cross-chat-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('cross chat assign', '验证跨聊天分派');
    await manager.addTask(project.slug, '跨聊天任务', '把任务推送到登记的执行对话');

    const workerReplies: string[] = [];
    await handleAgentCommand({
      args: `worker east ${project.slug}`,
      chatId: 'oc_worker',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        workerReplies.push(text);
      },
    });
    expect(workerReplies[0]).toMatch(/已登记执行对话/);

    const assignReplies: Array<{ card?: object; fallback: string }> = [];
    const sentCards: Array<{ chatId: string; card: object; fallback: string }> = [];
    await handleAgentCommand({
      args: `assign T-001 east ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        assignReplies.push({ fallback: text });
      },
      replyCard: async (card, fallback) => {
        assignReplies.push({ card, fallback });
      },
      sendCardToChat: async (chatId, card, fallback) => {
        sentCards.push({ chatId, card, fallback });
      },
    });

    expect(assignReplies).toHaveLength(1);
    expect(assignReplies[0]?.fallback).toMatch(/已分派任务：T-001/);
    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]?.chatId).toBe('oc_worker');
    expect(sentCards[0]?.card).toMatchObject({ schema: '2.0' });
    const sentCardCallbacks = callbackValues(sentCards[0]?.card);
    expect(sentCardCallbacks).toContainEqual({ cmd: 'agent.run', arg: `T-001 ${project.slug}` });
    expect(sentCardCallbacks).toContainEqual({ cmd: 'agent.status', arg: project.slug });
    expect(sentCards[0]?.fallback).toMatch(/\/agent run T-001/);
    expect(sentCards[0]?.fallback).toMatch(/\/agent review T-001/);

    const assignedBoard = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(assignedBoard.tasks[0]).toMatchObject({
      status: 'assigned',
      assignedTo: 'east',
      workerChatId: 'oc_worker',
      supervisorChatId: 'oc_supervisor',
    });
  });

  it('notifies the supervisor when an assigned worker run fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-worker-fail-notify-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const project = await manager.createProject('worker fail notify', '验证执行失败通知主控');
    await manager.addTask(project.slug, '失败任务', 'fail and notify');
    await manager.registerWorker(project.slug, 'east', 'oc_worker');
    await manager.assignTask(project.slug, 'T-001', 'east', 'oc_supervisor');

    const fakeFailingCodex = join(root, 'fake-notify-failing-codex');
    await writeFile(
      fakeFailingCodex,
      [
        '#!/bin/sh',
        'printf "worker exploded\\n" >&2',
        'exit 42',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeFailingCodex, 0o755);

    const workerReplies: string[] = [];
    const supervisorMessages: Array<{ chatId: string; text: string }> = [];
    await handleAgentCommand({
      args: `run T-001 ${project.slug}`,
      chatId: 'oc_worker',
      codexBin: fakeFailingCodex,
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        workerReplies.push(text);
      },
      sendToChat: async (chatId, text) => {
        supervisorMessages.push({ chatId, text });
      },
    });
    await waitFor(async () => {
      const task = await manager.getTask(project.slug, 'T-001');
      return task.status === 'failed' && workerReplies.join('\n').includes('调度任务失败');
    });

    expect(workerReplies.join('\n')).toMatch(/调度任务失败/);
    expect(supervisorMessages).toHaveLength(1);
    expect(supervisorMessages[0]).toMatchObject({ chatId: 'oc_supervisor' });
    expect(supervisorMessages[0]?.text).toMatch(/执行对话任务失败/);
    expect(supervisorMessages[0]?.text).toMatch(/状态：failed/);
    expect(supervisorMessages[0]?.text).toMatch(/worker exploded/);
  });

  it('runs assigned tasks from multiple worker chats and keeps their isolated outputs separate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-multi-worker-e2e-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const project = await manager.createProject('multi worker e2e', '验证多执行对话闭环');
    await manager.addTask(project.slug, '执行任务 A', 'write worker A result');
    await manager.addTask(project.slug, '执行任务 B', 'write worker B result');

    await manager.registerWorker(project.slug, 'east', 'oc_worker_east');
    await manager.registerWorker(project.slug, 'west', 'oc_worker_west');
    await manager.assignTask(project.slug, 'T-001', 'east', 'oc_supervisor');
    await manager.assignTask(project.slug, 'T-002', 'west', 'oc_supervisor');

    const fakeMultiWorkerCodex = join(root, 'fake-multi-worker-codex');
    await writeFile(
      fakeMultiWorkerCodex,
      [
        '#!/bin/sh',
        'prompt="${@: -1}"',
        'case "$prompt" in',
        "  *T-001*) tid='T-001'; sid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; text='east result' ;;",
        "  *T-002*) tid='T-002'; sid='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; text='west result' ;;",
        "  *) tid='unknown'; sid='00000000-0000-0000-0000-000000000000'; text='unknown result' ;;",
        'esac',
        'mkdir -p outputs',
        'printf "%s\\n" "$text" > "outputs/${tid}-result.md"',
        'while [ "$1" != "" ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        '    printf "%s summary\\n" "$tid" > "$1"',
        '  fi',
        '  shift || exit 0',
        'done',
        'printf \'{"thread_id":"%s"}\\n\' "$sid"',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeMultiWorkerCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakeMultiWorkerCodex,
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    await Promise.all([
      runner.runTask(project.slug, 'T-001', 'oc_worker_east'),
      runner.runTask(project.slug, 'T-002', 'oc_worker_west'),
    ]);

    const board = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(board.tasks).toMatchObject([
      { id: 'T-001', status: 'reviewing', workerChatId: 'oc_worker_east' },
      { id: 'T-002', status: 'reviewing', workerChatId: 'oc_worker_west' },
    ]);
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toBe('east result\n');
    await expect(readFile(join(project.path, 'outputs', 'T-002-result.md'), 'utf8')).resolves.toBe('west result\n');
    await stat(join(project.path, 'worker_runs', 'T-001'));
    await stat(join(project.path, 'worker_runs', 'T-002'));
  });

  it('cleans isolated worker runs for accepted tasks from /agent clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-clean-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('clean worker runs', '验证清理隔离执行目录');
    await manager.addTask(project.slug, '已验收任务', 'accepted task');
    await manager.addTask(project.slug, '待复核任务', 'reviewing task');
    await manager.markTask(project.slug, 'T-001', 'accepted');
    await manager.markTask(project.slug, 'T-002', 'reviewing');
    await mkdir(join(project.path, 'worker_runs', 'T-001'), { recursive: true });
    await mkdir(join(project.path, 'worker_runs', 'T-002'), { recursive: true });
    await writeFile(join(project.path, 'worker_runs', 'T-001', 'trace.md'), 'old accepted trace\n', 'utf8');
    await writeFile(join(project.path, 'worker_runs', 'T-002', 'trace.md'), 'active reviewing trace\n', 'utf8');

    const replies: string[] = [];
    await handleAgentCommand({
      args: `clean ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        replies.push(text);
      },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/已清理 1 个隔离执行目录/);
    await expect(stat(join(project.path, 'worker_runs', 'T-001'))).rejects.toThrow();
    await stat(join(project.path, 'worker_runs', 'T-002'));
  });

  it('renders result review cards as CardKit 2.0 callback cards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-review-card-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('review card', '验证复核卡');
    await manager.addTask(project.slug, '复核按钮', '生成待复核结果');
    await writeFile(join(project.path, 'outputs', 'T-001-result.md'), 'review body\n', 'utf8');
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const cards: Array<{ card: object; fallback: string }> = [];
    await handleAgentCommand({
      args: `result T-001 ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async () => undefined,
      replyCard: async (card, fallback) => {
        cards.push({ card, fallback });
      },
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]?.card).toMatchObject({ schema: '2.0' });
    const callbacks = callbackValues(cards[0]?.card);
    expect(callbacks).toContainEqual({ cmd: 'agent.review', arg: `T-001 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-001 accepted ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.mark', arg: `T-001 rework ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.mark', arg: `T-001 done ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.status', arg: project.slug });
  });

  it('does not render premature result or review actions for non-reviewable board tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-board-actions-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('board action states', '验证任务板按钮状态');
    await manager.addTask(project.slug, '待执行任务', 'pending task');
    await manager.addTask(project.slug, '执行中任务', 'running task');
    await manager.markTask(project.slug, 'T-002', 'running');

    const cards: Array<{ card: object; fallback: string }> = [];
    await handleAgentCommand({
      args: `status ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async () => undefined,
      replyCard: async (card, fallback) => {
        cards.push({ card, fallback });
      },
    });

    expect(cards).toHaveLength(1);
    const callbacks = callbackValues(cards[0]?.card);
    expect(callbacks).toContainEqual({ cmd: 'agent.run', arg: `T-001 ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.status', arg: project.slug });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.result', arg: `T-001 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.result', arg: `T-002 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.run', arg: `T-002 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-001 accepted ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-002 accepted ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.review', arg: `T-001 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.review', arg: `T-002 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-001 rework ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-002 rework ${project.slug}` });
  });

  it('renders plan approval actions without premature run buttons for planned tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-planned-card-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('planned card', '验证计划按钮');
    await manager.addTask(project.slug, '复杂任务', '需要计划确认：先写计划');
    await manager.planTask(project.slug, 'T-001');

    const cards: Array<{ card: object; fallback: string }> = [];
    await handleAgentCommand({
      args: `status ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async () => undefined,
      replyCard: async (card, fallback) => {
        cards.push({ card, fallback });
      },
    });

    const callbacks = callbackValues(cards[0]?.card);
    expect(callbacks).toContainEqual({ cmd: 'agent.approve', arg: `T-001 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.run', arg: `T-001 ${project.slug}` });
  });

  it('rejects stale single-task run clicks before sending a launch acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-run-preflight-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('run preflight', '验证旧卡防误触');
    await manager.addTask(project.slug, '已待复核任务', 'reviewing task');
    await writeFile(join(project.path, 'outputs', 'T-001-result.md'), 'review body\n', 'utf8');
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const replies: string[] = [];
    await handleAgentCommand({
      args: `run T-001 ${project.slug}`,
      chatId: 'oc_worker',
      codexBin: await fakeCodex(join(root, 'fake-codex'), 'should not run'),
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        replies.push(text);
      },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe('调度命令失败：T-001 当前状态是 reviewing，不能直接执行。');
    expect(replies[0]).not.toMatch(/已启动/);
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toBe('review body\n');
  });
});

function callbackValues(card: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const behaviors = record.behaviors;
    if (Array.isArray(behaviors)) {
      for (const behavior of behaviors) {
        if (
          behavior &&
          typeof behavior === 'object' &&
          (behavior as Record<string, unknown>).type === 'callback' &&
          (behavior as Record<string, unknown>).value &&
          typeof (behavior as Record<string, unknown>).value === 'object'
        ) {
          found.push((behavior as Record<string, unknown>).value as Record<string, unknown>);
        }
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(card);
  return found;
}
