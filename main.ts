// 导入所需模块
import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { Cron } from "https://deno.land/x/croner@6.0.3/dist/croner.js";

// 通用配置和工具类
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GITHUB_API = {
  baseUrl: "https://api.github.com",
  headers: (token: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Deno-App",
  }),
};

class AppError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

// 响应工具函数
const createJsonResponse = (data: unknown, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
};

// 任务数据验证
const validateTaskData = (task: any) => {
  if (!task.name?.trim()) throw new AppError("任务名称不能为空", 400);
  if (!task.repo?.trim()) throw new AppError("仓库地址不能为空", 400);
  if (!task.workflow?.trim()) throw new AppError("工作流不能为空", 400);
  if (!task.cron?.trim()) throw new AppError("cron表达式不能为空", 400);
};

// KV存储类
class TaskStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async list() {
    try {
      const tasks: any[] = [];
      const iter = this.kv.list({ prefix: ["tasks"] });

      for await (const { key, value } of iter) {
        tasks.push({ id: key[1], ...value });
      }

      return tasks;
    } catch (error) {
      console.error("Error listing tasks:", error);
      return [];
    }
  }

  async get(id: string) {
    const result = await this.kv.get(["tasks", id]);
    if (!result.value) throw new AppError("任务不存在", 404);
    return result.value;
  }

  async create(taskData: any) {
    const id = crypto.randomUUID();
    await this.kv.set(["tasks", id], {
      ...taskData,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async update(id: string, taskData: any) {
    const existing = await this.get(id);
    await this.kv.set(["tasks", id], {
      ...existing,
      ...taskData,
      updated_at: new Date().toISOString(),
    });
  }

  async delete(id: string) {
    await this.kv.delete(["tasks", id]);
  }

  async checkNameExists(name: string, excludeId: string | null = null) {
    const tasks = await this.list();
    return tasks.some((t) => t.name === name.trim() && t.id !== excludeId);
  }
}

// GitHub API 操作类
class GitHubAPI {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async request(endpoint: string, options: any = {}) {
    const response = await fetch(`${GITHUB_API.baseUrl}${endpoint}`, {
      ...options,
      headers: GITHUB_API.headers(this.token),
    });

    if (!response.ok) {
      throw new AppError(
        `GitHub API 请求失败: ${response.statusText}`,
        response.status,
      );
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async getWorkflowInfo(repo: string, workflow: string) {
    const workflowPath = workflow.includes("/")
      ? workflow.split("/").pop()
      : workflow;
    return this.request(`/repos/${repo}/actions/workflows/${workflowPath}`);
  }

  async triggerWorkflow(repo: string, workflow: string, ref: string) {
    const workflowPath = workflow.includes("/")
      ? workflow.split("/").pop()
      : workflow;
    await this.request(`/repos/${repo}/actions/workflows/${workflowPath}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref }),
    });
  }

  async getRepoInfo(repo: string) {
    const [branches, workflows] = await Promise.all([
      this.request(`/repos/${repo}/branches`),
      this.request(`/repos/${repo}/actions/workflows`),
    ]);

    if (!branches || !workflows?.workflows) {
      throw new AppError("无法获取仓库信息", 400);
    }

    return {
      branches: branches.map((b: any) => b.name),
      workflows: workflows.workflows.map((w: any) => ({
        name: w.name,
        path: w.path,
      })),
    };
  }

  async getWorkflowStatus(repo: string, workflow: string) {
    try {
      // 1. 先检查工作流是否存在和状态
      const workflowInfo = await this.request(
        `/repos/${repo}/actions/workflows/${workflow}`,
      ).catch((error) => {
        if (error.status === 404) {
          return { state: "not_found" };
        }
        throw error;
      });

      // 工作流不存在
      if (workflowInfo.state === "not_found") {
        return {
          last_run: null,
          status: "NOT_FOUND",
          run_id: null,
          message: "工作流不存在",
        };
      }

      // 工作流被禁用
      if (workflowInfo.state === "disabled") {
        return {
          last_run: null,
          status: "DISABLED",
          run_id: null,
          message: "工作流已禁用",
        };
      }

      // 2. 获取最近的运行记录
      const data = await this.request(
        `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`,
      );

      // 从未运行过
      if (!data.workflow_runs?.length) {
        return {
          last_run: null,
          status: "NEVER_RUN",
          run_id: null,
          message: "工作流从未运行",
        };
      }

      const latestRun = data.workflow_runs[0];
      let status = "RUNNING";
      let message = "正在运行";

      if (latestRun.status === "completed") {
        switch (latestRun.conclusion) {
          case "success":
            status = "SUCCESS";
            message = "执行成功";
            break;
          case "cancelled":
            status = "CANCELLED";
            message = "已取消";
            break;
          case "failure":
            status = "FAILURE";
            message = "执行失败";
            break;
          default:
            status = latestRun.conclusion.toUpperCase();
            message = `状态: ${latestRun.conclusion}`;
        }
      }

      return {
        last_run: latestRun.created_at,
        status,
        run_id: latestRun.id,
        message,
      };
    } catch (error) {
      // API 访问错误
      return {
        last_run: null,
        status: "API_ERROR",
        run_id: null,
        message: `API 错误: ${error.message}`,
      };
    }
  }

  async cancelWorkflow(repo: string, runId: string) {
    await this.request(`/repos/${repo}/actions/runs/${runId}/cancel`, {
      method: "POST",
    });
  }
}

// 主应用
const app = new Application();
const router = new Router();

// 初始化 KV 存储和 GitHub API
let taskStore: TaskStore;
let github: GitHubAPI;

// 中间件
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof AppError) {
      ctx.response.status = err.status;
      ctx.response.body = { error: err.message };
    } else {
      console.error("Unexpected error:", err);
      ctx.response.status = 500;
      ctx.response.body = { error: "Internal server error" };
    }
  }
});

// CORS 中间件
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type",
  );
  await next();
});

// 路由
router
  .get("/", async (ctx) => {
    const file = await Deno.readFile("./static/index.html");
    ctx.response.headers.set("Content-Type", "text/html;charset=UTF-8");
    ctx.response.body = file;
  })
  .get("/api/tasks", async (ctx) => {
    const tasks = await taskStore.list();
    ctx.response.body = tasks;
  })
  .post("/api/tasks", async (ctx) => {
    const task = await ctx.request.body().value;
    validateTaskData(task);

    if (await taskStore.checkNameExists(task.name)) {
      throw new AppError("任务名称已存在", 400);
    }

    const id = await taskStore.create({
      name: task.name.trim(),
      repo: task.repo.trim(),
      workflow: task.workflow.trim(),
      ref: task.ref || "main",
      cron: task.cron.trim(),
      description: task.description?.trim() || "",
    });
    ctx.response.body = { id };
  })
  .put("/api/tasks", async (ctx) => {
    const task = await ctx.request.body().value;
    if (!task.id) throw new AppError("缺少任务ID", 400);
    validateTaskData(task);

    if (await taskStore.checkNameExists(task.name, task.id)) {
      throw new AppError("任务名称已存在", 400);
    }

    await taskStore.update(task.id, {
      name: task.name.trim(),
      repo: task.repo.trim(),
      workflow: task.workflow.trim(),
      ref: task.ref || "main",
      cron: task.cron.trim(),
      description: task.description?.trim() || "",
    });
    ctx.response.body = { success: true };
  })
  .delete("/api/tasks", async (ctx) => {
    const { id } = await ctx.request.body().value;
    if (!id) throw new AppError("缺少任务ID", 400);
    await taskStore.delete(id);
    ctx.response.body = { success: true };
  })
  .get("/api/tasks/repo-info", async (ctx) => {
    const repo = ctx.request.url.searchParams.get("repo");
    if (!repo) throw new AppError("缺少仓库参数", 400);
    const repoInfo = await github.getRepoInfo(repo);
    ctx.response.body = repoInfo;
  })
  .post("/api/tasks/run", async (ctx) => {
    const { id } = await ctx.request.body().value;
    const task = await taskStore.get(id);

    // 检查工作流状态
    const workflowInfo = await github.getWorkflowInfo(task.repo, task.workflow);
    if (workflowInfo.state !== "active") {
      ctx.response.body = {
        status: "disabled",
        message: "工作流已禁用，请先启用后再试",
      };
      return;
    }

    await github.triggerWorkflow(task.repo, task.workflow, task.ref);
    ctx.response.body = { success: true };
  })
  .post("/api/tasks/status", async (ctx) => {
    const { repo, workflow } = await ctx.request.body().value;
    const status = await github.getWorkflowStatus(repo, workflow);
    ctx.response.body = status;
  })
  .post("/api/tasks/cancel", async (ctx) => {
    const { repo, run_id } = await ctx.request.body().value;
    await github.cancelWorkflow(repo, run_id);
    ctx.response.body = { success: true };
  });

app.use(router.routes());
app.use(router.allowedMethods());

// 静态文件服务
app.use(async (ctx, next) => {
  try {
    const filePath = `./static${ctx.request.url.pathname}`;
    const fileInfo = await Deno.stat(filePath);
    if (fileInfo.isFile) {
      const file = await Deno.readFile(filePath);
      const contentType = getContentType(filePath);
      ctx.response.headers.set("Content-Type", contentType);
      ctx.response.body = file;
    } else {
      await next();
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await next();
    } else {
      throw error;
    }
  }
});

// 获取文件的 Content-Type
function getContentType(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html;charset=UTF-8",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };
  return types[ext || ""] || "text/plain";
}

// 启动应用
async function startApp() {
  // 初始化 KV 和 GitHub API
  const kv = await Deno.openKv();
  taskStore = new TaskStore(kv);
  github = new GitHubAPI(Deno.env.get("GITHUB_TOKEN") || "");

  // 设置定时任务
  const tasks = await taskStore.list();
  for (const task of tasks) {
    new Cron(task.cron, async () => {
      try {
        await github.triggerWorkflow(task.repo, task.workflow, task.ref);
        console.log(`✅ [${task.name}] 定时任务执行成功`);
      } catch (error) {
        console.error(`❌ [${task.name}] 定时任务执行失败:`, error.message);
      }
    });
  }

  console.log("Server running on http://localhost:8000");
  await app.listen({ port: 8000 });
}

startApp().catch((err) => {
  console.error("Failed to start server:", err);
  Deno.exit(1);
});