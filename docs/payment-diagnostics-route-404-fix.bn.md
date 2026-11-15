# Payment Diagnostics Investigate — HTML 404 root cause ও fix

তারিখ: ৩০ অক্টোবর ২০২৬। Repository: `E:\Ecommerce\General\general_ecommerce`। HEAD `0665ace59c34107af40156c24cd5649fb7e122a0`; আগের uncommitted hardening work সংরক্ষিত। Commit/push/deploy হয়নি।

## নিশ্চিত root cause

Installed **Next.js 16.3.7-এর development route discovery initial-scan race**। Watchpack directory traversal শেষ হওয়ার আগে `aggregated` event দিতে পারে। Next-এর `setup-dev-bundler.js` তখন incomplete `getTimeInfoEntries()` থেকে `appFiles`/dynamic route table/types publish করে। কিছু file missing অথবা metadata `accuracy` pending থাকলে source থাকা সত্ত্বেও route বাদ যায়।

চলমান server-এর catalog-এ diagnostics root ছিল, কিন্তু `/diagnostics/[id]`, `/diagnostics/captures` এবং আরও nested payment routes ছিল না। Source-এর ৪৭৬টি API route-এর মধ্যে ১১৯টি source path generated dev catalog-এ অনুপস্থিত ছিল; metadata/normalized route names থাকায় total catalog count-এর সঙ্গে সরাসরি subtraction এক নয়। Fresh independent watcher সব source route পড়তে পেরেছে। এটি directory missing/permission failure নয়।

Dev trace-এ `/api/admin/payment-control/diagnostics/25`-এর `ensure-page` → `failed: true`, পরে `_not-found/page` render আছে। `/diagnostics/captures?paymentId=25`-ও framework not-found render-এ গেছে। User-এর response `404 text/html; charset=utf-8` এই failure-এর সঙ্গে মিলে যায়। **Cache corruption আলাদাভাবে প্রমাণিত নয়**; cache delete-কে স্থায়ী fix হিসেবে ব্যবহার করা হয়নি।

[Upstream Next 16.4.3 source](https://github.com/vercel/next.js/blob/v16.4.3/packages/next/src/server/lib/router-utils/setup-dev-bundler.ts)-এ partial initial scan ও pending metadata handling-এর guard আছে। Published 16.3.8 source-এ initial snapshot guard পাওয়া যায়নি। পুরো application framework minor upgrade না করে installed 16.3.7-এর dev-only scan completion backport করা হয়েছে।

## অন্য সম্ভাবনা যাচাই

| Layer | Evidence |
| --- | --- |
| Frontend URLs | `PaymentDiagnostics.tsx` root-relative `/api/admin/payment-control/diagnostics/${selected}` ও `/captures?paymentId=${selected}` পাঠায়; `selected` হলো `p.id`, order ID নয়। |
| App Router handlers | `[id]/route.ts` ও `captures/route.ts` দুটোতেই GET আছে। Dynamic params awaited Promise; installed Next convention সঠিক। Production build manifest-এ দুটো route-ই registered ছিল। |
| `proxy.ts` | Global payment permission rule দুই URL-এ প্রযোজ্য। Anonymous → JSON 401; insufficient global grant → JSON 403। API branch HTML 404 তৈরি করে না। |
| Handler authorization | `requireDiagnosticAccess` → existing non-banned global manager gate ও rate limiter; read route-এর জন্য নতুন capture/export grant প্রয়োজন নয়। পরিবর্তন করা হয়নি। |
| Payment 25 | Actual configured DB-তে explicit `SET TRANSACTION READ ONLY`, repeatable-read lookup: id 25, provider EPS, status CAPTURED, orderId 23, Order relation exists; exact diagnostics eligibility query matched। Credentials/customer payload প্রকাশ হয়নি। |
| Application 404 | Payment missing/ineligible হলে `PaymentControlError` → ছোট `application/json` error। এটি framework-generated HTML page নয়। |
| Unauthenticated localhost probe | দুটো exact URL ও overview JSON 401 দিয়েছে। Proxy auth gate route matching-এর আগেই reject করতে পারে, তাই এই probe একা handler registration প্রমাণ নয়। |

## Fix

`scripts/lib/next-dev-route-scan.cjs` startup app/pages files-এর bounded filesystem snapshot নেয়। Development watcher aggregation-এর map clone করে existing real startup files থেকে missing/pending metadata পূরণ করে; Watchpack-এর নিজস্ব map mutate করে না। Deleted files, directories ও unresolvable paths phantom route হিসেবে publish হয় না। Known metadata বজায় থাকে; permission errors explicit fail করে। Symlink directories traverse করে না।

`scripts/patch-next-dev-route-discovery.cjs` installed CJS ও ESM dev-router module-এ এই completion বসায়। Next version **16.3.7** ও দুটো original SHA-256 source fingerprint match ছাড়া patch নয়। দুই module আগে validate হয়; তারপর atomic temporary-file rename। Repeated run idempotent। Upstream `initialPageFiles` guard থাকা release অপরিবর্তিত থাকে; অন্য unknown source/version review error দেয়। Patch-এর production server/route modules, proxy/RBAC, financial records বা provider calls-এর সঙ্গে dependency নেই।

`package.json`-এ `predev` এবং existing `postinstall` chain-এ patch installer আছে। Clean `npm ci` ও `npm run dev`-এ fix পুনরায় প্রয়োগ হয়; node_modules-এর manual edit হারিয়ে গেলে silent regression হয় না। Existing postinstall Prisma generation/copy steps বহাল। এই task-এ postinstall/generate/migration চালানো হয়নি।

## Safe reproduction ও regression

Actual দুই GET handler একটি disposable filesystem fixture-এ copy করা হয়; fixture-এ synthetic authorization/payment services, fixed test Payment 25/Order 23 এবং no-op fixture proxy আছে। Production authentication কখনও bypass বা cookie/token forge করা হয়নি। Separate unit tests actual application authorization/GET modules load করে manager/anonymous/warehouse/banned cases যাচাই করে।

Real Next dev smoke test কেবল Watchpack থেকে ওই দুই route-এর entries বাদ দেয়—অর্থাৎ partial-scan condition deterministically তৈরি করে। App files ও authorization/service outcomes একই রাখা হয়।

| Condition | Actual result |
| --- | --- |
| Before fix, authorized fixture request to `/diagnostics/25` | 404 HTML |
| Before fix, authorized fixture request to `/diagnostics/captures?paymentId=25` | 404 HTML |
| After fix, authorized fixture request, দুটো endpoint | 200 JSON |
| After fix, missing payment 999, দুটো endpoint | 404 JSON |
| After fix, invalid payment ID 0, দুটো endpoint | 400 JSON |
| After fix, anonymous, দুটো endpoint | 401 JSON |
| After fix, forbidden role, দুটো endpoint | 403 JSON |
| Genuinely missing fixture URL | 404 HTML — framework/app error distinction বহাল |

Fixture শুধু loopback HTTP ব্যবহার করে; `.env`, actual DB, gateway credentials বা bank HTTP load করে না। Cleanup কেবল test-owned child process tree ও validated fixture directory-তে সীমিত। কোনো database record write করা হয়নি। Initial fixture setup-এ parent proxy resolve হওয়ার কারণে 500 এসেছিল; fixture-local proxy দিয়ে test isolation ঠিক করার পর before-fix HTML 404 এবং after-fix JSON results সফল হয়েছে। সেই 500-কে product root cause বলা হয়নি।

## Commands ও results

Node 24.22.1 দিয়ে চালানো হয়েছে:

```powershell
npm run test:payment-diagnostics
npm run test:payment-diagnostics:routes
npm run typecheck
npm run lint
```

- Payment Diagnostics + new scan/GET unit regressions: **280 PASS, 0 FAIL, 0 SKIPPED**।
- Real Next dev fixed-routing smoke: **12 PASS, 0 FAIL, 0 SKIPPED** (parent/subtest records-সহ)।
- Before-fix reproduction: **3 PASS** মানে দুটো intentional HTML 404 পুনরুৎপাদন নিশ্চিত হয়েছে; এগুলো fixed coverage-এর সঙ্গে আবার যোগ করা হয়নি।
- TypeScript `tsc --noEmit`: **PASS, exit 0**।
- Full repository ESLint: **PASS, exit 0**।
- Git whitespace check: **PASS**।

প্রথম TypeScript run পুরোনো malformed `.next/dev/types/routes.d.ts`/`validator.ts`-এ ব্যর্থ হয়েছিল। Patched dev server restart করে complete types regenerate হওয়ার পর syntax diagnostics 0 এবং full typecheck exit 0। Type checking disable/ignore করা হয়নি। প্রথম lint run lifecycle CJS installer-এর চারটি `require` import-এ style error দিয়েছিল; plain Node lifecycle প্রয়োজনের জন্য শুধু ওই CJS file-এ documented import-rule exception দিয়ে final full lint pass করেছে; global lint rules পরিবর্তন হয়নি।

Actual repository dev server-এর পরিচয়/parent command যাচাই করে শুধু সেই process tree restart হয়েছে; port 3000-এ patched Node 24.22.1 server চালু আছে। Cache delete বা `.env` edit করা হয়নি। Restart-এর পরে generated route types **483 entries**, source-এর **476 API paths-এর missing count 0**। Diagnostics `[id]`, captures এবং captures `[id]` তিনটি nested route-ই registered। Actual localhost anonymous probes দুই URL-এ JSON 401 দিয়েছে; existing logged-in browser-এর overview request runtime log-এ 200 হয়েছে। ওই browser-এর Investigate detail/capture clicks সরাসরি automate করা হয়নি; 200/error behavior controlled HTTP regressions-এ যাচাই হয়েছে।

## Changed files — এই follow-up task

- `E:\Ecommerce\General\general_ecommerce\scripts\patch-next-dev-route-discovery.cjs`
- `E:\Ecommerce\General\general_ecommerce\scripts\lib\next-dev-route-scan.cjs`
- `E:\Ecommerce\General\general_ecommerce\tests\next-dev-route-discovery.test.mjs`
- `E:\Ecommerce\General\general_ecommerce\tests\payment-diagnostics-routes.test.mjs`
- `E:\Ecommerce\General\general_ecommerce\tests\payment-diagnostics-route-smoke.test.mjs`
- `E:\Ecommerce\General\general_ecommerce\package.json`
- `E:\Ecommerce\General\general_ecommerce\.github\workflows\payment-diagnostics.yml`
- `E:\Ecommerce\General\general_ecommerce\docs\payment-diagnostics-operations.md`
- `E:\Ecommerce\General\general_ecommerce\docs\payment-diagnostics-route-404-fix.bn.md`

Installed `node_modules/next/dist/server/lib/router-utils/setup-dev-bundler.js` ও ESM counterpart-ও installer দিয়ে patched হয়েছে; এগুলো Git-tracked changes নয়। কোনো dependency version/lockfile upgrade হয়নি। Diagnostics API handler, frontend URL, proxy/RBAC ও payment verification/settlement/inventory code এই follow-up-এ পরিবর্তিত হয়নি।

## সীমা ও rollback

Synthetic authorized HTTP tests actual user browser session verification নয়। Actual localhost-এর auth guard ও regenerated route catalog আলাদাভাবে যাচাই করা হয়; user-এর session cookie পড়া বা automation login করা হয়নি। Live EPS/AIBL request চালানো হয়নি।

Future Next upgrade-এ upstream fixed behavior ও এই HTTP regressions pass হলে backport সরানো যাবে। Rollback প্রয়োজন হলে dev server বন্ধ করে reviewed prior scripts/package configuration ও clean dependency install ব্যবহার করুন; database rollback/reset নয়। `.env`, database records, commit/push/deploy এই task-এর scope-এ বদলানো হয়নি।
