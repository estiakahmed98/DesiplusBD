// Real Next dev HTTP/routing with the actual two GET handlers, synthetic
// authorization/services and NO application database, .env or bank credentials.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
const runFile = promisify(execFile);
const repository = resolve(".");
const enabled = process.env.PAYMENT_DIAGNOSTICS_ROUTE_SMOKE === "true";
const expectBroken = process.env.PAYMENT_ROUTE_EXPECT_BROKEN === "true";
test("real Next dev route registration under a deliberately partial Watchpack scan", {
  skip: !enabled ? "Explicit isolated route-smoke opt-in required" : false, timeout: 180000,
}, async t => {
  const root = await mkdtemp(join(repository, ".payment-route-smoke-"));
  let child, closed, output = "", startupError;
  const put = async (name, data) => { const target = join(root, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, data); };
  try {
    // Preserve the real route topology to exercise nested static/dynamic routes.
    async function scaffold(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await scaffold(file);
        else if (entry.name === "route.ts") await put(relative(repository, file), 'export async function GET() { return Response.json({ fixture: true }); }');
      }
    }
    await scaffold(join(repository, "app/api"));
    const base = "app/api/admin/payment-control/diagnostics/";
    for (const route of ["[id]/route.ts", "captures/route.ts"]) await put(base + route, await readFile(join(repository, base, route), "utf8"));
    await put("package.json", JSON.stringify({ name: "payment-route-isolated-fixture", private: true }));
    await put("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2020", lib: ["dom", "esnext"], module: "esnext", moduleResolution: "bundler", jsx: "react-jsx", noEmit: true, skipLibCheck: true, paths: { "@/*": ["./*"] } }, include: ["**/*.ts", "**/*.tsx"] }));
    await put("next.config.mjs", `export default { turbopack: { root: ${JSON.stringify(repository)} }, devIndicators: false, experimental: { turbopackFileSystemCacheForDev: false } };`);
    await put("app/layout.tsx", 'export default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html>; }');
    await put("app/page.tsx", 'export default function Page() { return <main>Isolated route fixture</main>; }');
    await put("proxy.ts", 'import {NextResponse} from "next/server"; export function proxy(){return NextResponse.next();}');
    await put("lib/payment-control/authorization.ts", `
      export class PaymentControlError extends Error { constructor(message: string, readonly status=400) { super(message); } }
      export function positiveId(value: unknown) { const id=Number(value); if(!Number.isSafeInteger(id)||id<=0) throw new PaymentControlError("Valid payment/refund ID required"); return id; }
      export function paymentControlErrorResponse(error: unknown) { return Response.json({error:error instanceof PaymentControlError?error.message:"Unavailable"},{status:error instanceof PaymentControlError?error.status:500,headers:{"Cache-Control":"private, no-store"}}); }
    `);
    await put("lib/payment-control/diagnostic-authorization.ts", `
      import { PaymentControlError } from "./authorization";
      export async function requireDiagnosticAccess(request: Request) { const role=request.headers.get("x-fixture-role"); if(!role)throw new PaymentControlError("Unauthorized",401); if(role!=="manager")throw new PaymentControlError("Forbidden",403); return {userId:"synthetic-fixture-manager"}; }
      export async function auditDiagnosticAction() { throw new Error("Smoke test must not export or write audit records"); }
    `);
    await put("lib/payment-control/investigation.ts", 'import { PaymentControlError } from "./authorization"; export async function getPaymentInvestigation(id: number) { if(id!==25)throw new PaymentControlError("EPS/AIBL payment attempt not found",404);return {version:2,payment:{id,orderId:23,provider:"EPS"}}; }');
    await put("lib/payment-control/investigation-report.ts", 'export function evidenceManifest(){throw new Error("No exports");} export const investigationCsv=evidenceManifest; export const investigationPdf=evidenceManifest;');
    await put("lib/prisma.ts", 'export const prisma={paymentDiagnosticCapture:{findMany:async()=>[]},payment:{findFirst:async({where}: {where:{id:number}})=>where.id===25?{provider:"EPS"}:null}};');
    await put("lib/payment-control/capture.ts", 'export const captureProjection={};export async function requestCapture(){throw new Error("No capture jobs");}');
    await put("lib/network-monitor/policy.ts", 'export async function readMonitorBody(){throw new Error("No mutation");}');
    await put("lib/payment-control/diagnostic-readiness.ts", 'export function diagnosticReadiness(){return {capture:{policy:"CAPTURE_DISABLED",authenticationConfigured:false,destinations:{EPS:"NOT_CONFIGURED_OR_INVALID"}}};}');
    await put("lib/payment-control/capture-policy.ts", 'export type CaptureProvider="EPS"|"AIBL_WALLET"; export function approvedCaptureIps(){throw new Error("No network scope");}export function captureScopeDigest(){return "synthetic";}');
    const watchpack = resolve("node_modules/next/dist/compiled/watchpack").replaceAll("\\", "/");
    await put("partial-watchpack.cjs", `
      const Watchpack=require(${JSON.stringify(watchpack)}), original=Watchpack.prototype.getTimeInfoEntries;
      Watchpack.prototype.getTimeInfoEntries=function(){const entries=new Map(original.call(this));for(const file of entries.keys()){const p=file.replaceAll("\\\\","/");if(p.endsWith("/app/api/admin/payment-control/diagnostics/[id]/route.ts")||p.endsWith("/app/api/admin/payment-control/diagnostics/captures/route.ts"))entries.delete(file);}return entries;};
    `);
    const socket = createServer(); await new Promise(accept => socket.listen(0, "127.0.0.1", accept));
    const port = socket.address().port; await new Promise(accept => socket.close(accept));
    const env = { NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--max-old-space-size=6144 --require="${join(root, "partial-watchpack.cjs").replaceAll("\\", "/")}"` };
    for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (process.env[key]) env[key] = process.env[key];
    const started = new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("ISOLATED_NEXT_STARTUP_TIMEOUT: " + output.slice(-1500))), 90000);
      child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", root, "--turbopack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      closed = new Promise(done => child.once("close", done));
      const chunk = data => { output = (output + data.toString()).slice(-50000); if (/Ready in/.test(output)) { clearTimeout(timer); accept(); } };
      child.stdout.on("data", chunk); child.stderr.on("data", chunk);
      child.once("error", error => { clearTimeout(timer); startupError = error; reject(error); });
      child.once("exit", code => { clearTimeout(timer); if (!/Ready in/.test(output)) reject(new Error(`ISOLATED_NEXT_EXIT_${code}: ${output.slice(-1500)}`)); });
    });
    await started;
    const call = async (path, role = "manager") => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: role ? { "x-fixture-role": role } : {}, redirect: "manual", signal: AbortSignal.timeout(60000) });
      const body = await response.text(); return { status: response.status, type: response.headers.get("content-type"), body };
    };
    const routes = ["/api/admin/payment-control/diagnostics/25", "/api/admin/payment-control/diagnostics/captures?paymentId=25"];
    if (expectBroken) {
      for (const route of routes) await t.test(`before fix: ${route} is framework HTML 404`, async () => {
        const r = await call(route); assert.equal(r.status, 404); assert.match(r.type, /text\/html/);
      });
    } else {
      for (const route of routes) {
        for (const [name, target, role, status] of [
          ["authorized", route, "manager", 200], ["missing payment", route.replace(/25$/, "999"), "manager", 404],
          ["invalid ID", route.replace(/25$/, "0"), "manager", 400], ["unauthorized", route, null, 401], ["forbidden", route, "warehouse", 403],
        ]) await t.test(`${name}: ${target} is application JSON ${status}`, async () => {
          const r = await call(target, role); assert.equal(r.status, status); assert.match(r.type, /application\/json/);
          assert.ok(JSON.parse(r.body));
        });
      }
      await t.test("a genuinely missing framework route remains HTML 404", async () => {
        const r = await call("/api/no-such-fixture-route"); assert.equal(r.status, 404); assert.match(r.type, /text\/html/);
      });
    }
    t.diagnostic("Only a disposable filesystem fixture, synthetic roles/services and loopback HTTP were used; no .env or database loaded.");
  } finally {
    await writeFile(join(repository, ".next/payment-route-smoke-server.log"), output);
    if (child && !startupError && child.exitCode === null) {
      if (process.platform === "win32") await runFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      else child.kill("SIGTERM");
    }
    if (closed && !startupError) await closed;
    const rel = relative(repository, resolve(root));
    assert.ok(rel.startsWith(".payment-route-smoke-") && !isAbsolute(rel) && !(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true, force: true });
  }
});
