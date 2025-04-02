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
router.post("/api/tasks/toggle", async (ctx) => {
  const { id, enabled } = await ctx.request.body().value;
  const task = await taskStore.get(id);

  await taskStore.update(id, {
    ...task,
    enabled: enabled !== undefined ? enabled : !task.enabled
  });

  ctx.response.body = { success: true };
});
// 在 main.ts 中添加路由
router.get("/github-actions.svg", (ctx) => {
  ctx.response.headers.set("Content-Type", "image/svg+xml");
  ctx.response.body = `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="256px" height="256px" viewBox="0 0 256 256" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" preserveAspectRatio="xMidYMid">
      <title>GitHub Actions</title>
      <g>
        <path d="M53.6039685,0 C83.20802,0 107.207937,23.9920988 107.207937,53.5905987 C107.207937,82.680675 84.0189518,106.340237 55.114959,107.142722 C55.114959,109.604229 55.2236658,114.254369 56.6164527,117.06215 C58.5489445,120.9564 70.1405637,128.207034 81.5082702,128.207034 L81.5082702,128.207034 L85.5922512,128.207034 C88.1588275,109.935846 103.848755,95.8749553 122.83189,95.8749553 C141.738056,95.8749553 157.382168,109.821336 160.043124,127.984427 L160.043124,127.984427 L181.17225,127.984427 C183.834123,109.821336 199.477318,95.8749553 218.383484,95.8749553 C239.158,95.8749553 255.999725,112.711564 255.999725,133.481814 C255.999725,154.251149 239.158,171.087757 218.383484,171.087757 C199.477318,171.087757 183.833206,157.140461 181.17225,138.97737 L181.17225,138.97737 L160.04404,138.97737 C157.383084,157.140461 141.738972,171.087757 122.83189,171.087757 C103.961461,171.087757 88.3384237,157.194509 85.633485,139.080887 L85.633485,139.080887 L81.1179234,139.21555 C73.6830071,139.15967 65.8284723,137.174293 59.5196976,132.887962 C57.799789,131.719045 56.105487,130.49088 54.3379305,129.32746 L54.3379305,129.32746 L54.3374174,131.769284 C54.3277767,132.558717 54.1853819,144.42618 54.1739371,157.602471 L54.1735534,160.392388 C54.1788974,169.03343 54.2472161,177.937094 54.4506363,184.431359 C54.8968779,198.678213 66.4854144,210.176832 79.2733971,212.868271 C80.9355782,213.217297 83.7935402,213.262185 85.5940838,213.106451 C88.1652417,194.841676 103.853336,180.786282 122.83189,180.786282 C143.606406,180.786282 160.448131,197.623807 160.448131,218.393141 C160.448131,239.162475 143.606406,256 122.83189,256 C104.063171,256 88.5088569,242.256073 85.6793004,224.286275 L85.6793004,224.286275 L82.4254937,224.286275 C57.9894145,222.952464 42.7970419,200.539685 43.0618547,182.362853 C43.3963068,159.485622 43.1443223,136.59923 43.1406571,113.716502 L43.1406571,113.716502 L43.1406571,106.152441 C18.5460568,101.286232 7.10542736e-14,79.6063152 7.10542736e-14,53.5905987 C7.10542736e-14,23.9920988 23.9990007,0 53.6039685,0 Z M122.83189,191.779225 C108.130658,191.779225 96.2122511,203.69466 96.2122511,218.393141 C96.2122511,233.091622 108.130658,245.007057 122.83189,245.007057 C137.534038,245.007057 149.452446,233.091622 149.452446,218.393141 C149.452446,203.69466 137.534038,191.779225 122.83189,191.779225 Z M122.83189,106.867899 C108.130658,106.867899 96.2122511,118.783333 96.2122511,133.481814 C96.2122511,148.17938 108.130658,160.094814 122.83189,160.094814 C137.534038,160.094814 149.452446,148.17938 149.452446,133.481814 C149.452446,118.783333 137.534038,106.867899 122.83189,106.867899 Z M218.383484,106.867899 C203.681336,106.867899 191.763845,118.783333 191.763845,133.481814 C191.763845,148.17938 203.681336,160.094814 218.383484,160.094814 C233.085632,160.094814 245.004039,148.17938 245.004039,133.481814 C245.004039,118.783333 233.085632,106.867899 218.383484,106.867899 Z M233.544061,122.276432 C235.638739,124.366008 235.696466,127.723436 233.714494,129.881717 L233.55414,130.050276 L217.244789,146.39495 C215.166604,148.478113 211.83033,148.547735 209.667845,146.592823 L209.495579,146.429761 L201.510879,138.569807 C199.347478,136.439924 199.319988,132.959741 201.450403,130.79688 C203.526755,128.688983 206.884104,128.609284 209.056668,130.577021 L209.225269,130.737334 L213.317496,134.764416 L225.769194,122.286509 C227.913353,120.136473 231.394404,120.132808 233.544061,122.276432 Z M137.554197,122.195909 C139.648875,124.285484 139.706603,127.642913 137.72463,129.80211 L137.564277,129.969752 L121.254926,146.314427 C119.176741,148.39759 115.840467,148.467212 113.677982,146.5123 L113.505716,146.349238 L105.521015,138.489283 C103.357614,136.359401 103.330125,132.879218 105.460539,130.716356 C107.535975,128.608459 110.894241,128.528761 113.066805,130.497414 L113.235405,130.656811 L117.327633,134.683893 L129.779331,122.205986 C131.92349,120.056866 135.404541,120.052285 137.554197,122.195909 Z M53.6039685,10.9929433 C30.0722845,10.9929433 10.9956858,30.0638679 10.9956858,53.5905987 C10.9956858,77.1164136 30.0722845,96.1882542 53.6039685,96.1882542 C77.1356525,96.1882542 96.2122511,77.1164136 96.2122511,53.5905987 C96.2122511,30.0638679 77.1356525,10.9929433 53.6039685,10.9929433 Z M49.1705996,28.1303923 C58.1348325,33.5160185 66.9781128,39.0866925 75.7013569,44.8414984 C83.0089064,49.661904 82.9905803,58.4040422 75.6014794,63.2354408 C66.7224631,69.0452113 57.7023355,74.6158854 48.5429292,79.9474629 C41.0878542,84.2869273 32.7430449,79.2970471 32.540541,70.6034611 C32.4104254,65.0007243 32.5167171,59.392491 32.5093866,53.7860899 C32.5029725,48.3317579 32.3957645,42.8746776 32.5277127,37.4230938 C32.7503754,28.1752802 41.2637851,23.3567067 49.1705996,28.1303923 Z M43.2613347,37.0016976 L43.2613347,40.8702976 C43.2604184,42.785818 43.2604184,44.6756881 43.2595021,46.5444885 L43.2585858,50.2546069 L43.2585858,55.7355052 C43.2595021,59.9659562 43.2613347,64.1295335 43.2686652,68.2931108 C43.2723304,70.252603 44.2921803,70.1729041 45.6116626,69.355762 C53.217012,64.6416215 60.8260266,59.9329774 68.4387064,55.2289137 C69.6967961,54.4529951 69.7325321,53.6422656 68.4982664,52.8635988 C60.3449653,47.7253138 52.1806686,42.6044344 43.2613347,37.0016976 Z" fill="#4A7EBF"></path>
        <path d="M133.22712,223.879078 C136.262846,223.879078 138.724963,221.41849 138.724963,218.382606 C138.724963,215.347638 136.262846,212.886134 133.22712,212.886134 C130.191394,212.886134 127.729277,215.347638 127.729277,218.382606 C127.729277,221.41849 130.191394,223.879078 133.22712,223.879078" fill="#85B3DF"></path>
        <path d="M112.178903,223.879078 C115.214629,223.879078 117.676746,221.41849 117.676746,218.382606 C117.676746,215.347638 115.214629,212.886134 112.178903,212.886134 C109.143178,212.886134 106.68106,215.347638 106.68106,218.382606 C106.68106,221.41849 109.143178,223.879078 112.178903,223.879078" fill="#85B3DF"></path>
        <path d="M218.383759,245.007057 C203.68161,245.007057 191.76412,233.091622 191.76412,218.393141 C191.76412,203.69466 203.68161,191.779225 218.383759,191.779225 C233.084991,191.779225 245.004314,203.69466 245.004314,218.393141 C245.004314,233.091622 233.084991,245.007057 218.383759,245.007057 M218.383759,180.786282 C199.477593,180.786282 183.833481,194.733579 181.172525,212.896669 L175.020439,212.896669 C172.334743,212.896669 170.155764,215.358172 170.155764,218.393141 C170.155764,221.429025 172.334743,223.889613 175.020439,223.889613 L181.172525,223.889613 C183.833481,242.052703 199.477593,256 218.383759,256 C239.158275,256 256,239.162475 256,218.393141 C256,197.623807 239.158275,180.786282 218.383759,180.786282" fill="#85B3DF"></path>
      </g>
  </svg>`;
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