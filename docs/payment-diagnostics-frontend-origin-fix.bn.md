# Frontend Payment Diagnostics: ngrok 403 তদন্ত ও fix

## নিশ্চিত root cause

`POST /api/payment-diagnostics/frontend`-এর প্রথম 403 branch ছিল:

```ts
request.headers.get("origin") !== new URL(request.url).origin
```

HTTPS ngrok origin browser-এর কাছে same-origin হলেও Next.js-এর server-side absolute request URL internal listener authority দিয়ে তৈরি হতে পারে। Installed Next 16.3.7-এর `next-server.js`-এর `attachRequestMeta()` listener hostname/port দিয়ে `initURL` তৈরি করে; `x-forwarded-proto` protocol-এ প্রভাব ফেলে, public hostname এই URL-এ থাকা নিশ্চিত নয়। Browser-এর `Sec-Fetch-Site: same-origin` তাই এই দুই URL সমান হওয়ার প্রমাণ নয়।

বাস্তব tunnel-এ `{}` JSON payload দিয়ে origin failure reproduce হয়েছে। প্রথমে শুধু fixed diagnostic reason header যোগ করে project dev server restart করার পর একই request-এ **403, `X-Payment-Diagnostic-Reason: ORIGIN_REJECTED`, empty body** পাওয়া গেছে। ওই পর্যায়ে strict comparison অপরিবর্তিত ছিল। ফলে session lookup, guest-token verification বা order lookup-এর আগের branch-ই failure-এর কারণ নিশ্চিত হয়েছে। এটি application-generated 403; ngrok interstitial বা framework HTML error নয়।

বিদ্যমান `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_URL`, `NEXTAUTH_URL`-এর origin tunnel-এর সঙ্গে মেলে—শুধু এই presence/match booleans পরীক্ষা করা হয়েছে। Secret values, cookies, session tokens ও request body সংগ্রহ/প্রকাশ করা হয়নি; `.env` লেখা হয়নি।

## Targeted change

`frontend-origin.ts` এখন দুইটি অনুমোদিত full origin মেলায়: actual request URL-এর origin এবং operator-configured canonical public origin। Existing public-URL precedence: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_SITE_URL`, `APP_URL`, `NEXTAUTH_URL`। প্রথম nonempty configuration ব্যবহৃত হয়; সেটি invalid হলে public-origin fallback fail closed করে। Configuration একটি HTTP(S) origin হতে হবে; trailing slash চলে, credentials/path/query/fragment চলে না। কোনো wildcard/domain suffix/tunnel-domain pattern allow করা হয়নি।

Request-এর Origin বাধ্যতামূলক ও canonical serialized HTTP(S) origin হতে হবে। Scheme, host এবং port মেলে। Fetch Metadata থাকলে `same-origin` প্রয়োজন; metadata একা অনুমোদন দিতে পারে না। Helper কোনো `Host`, `Forwarded`, `X-Forwarded-Host` বা `X-Forwarded-Proto` পড়েই না। Arbitrary forwarded headers থেকে public URL বানানো existing payment helper পুনর্ব্যবহার করা হয়নি। `next.config.ts`, proxy বা payment URL generation পরিবর্তন করা হয়নি।

Collector-এর দুইটি 403-এ শুধু fixed, non-sensitive reason header যোগ হয়েছে:

- `ORIGIN_REJECTED`: origin/Fetch Metadata validation ব্যর্থ।
- `OWNERSHIP_REJECTED`: order/session/guest-token ownership ব্যর্থ। Missing order, missing session ও bad token আলাদা করে প্রকাশ করা হয় না।

`Cache-Control: private, no-store` এবং empty error body বহাল। কোনো raw diagnostic logging যোগ করা হয়নি।

## Authentication ও ownership audit

- Browser helper relative URL ও `credentials: same-origin` ব্যবহার করে; tunnel-এও browser-এর same-origin cookie পাঠানোর আচরণ বহাল। Frontend helper বদলানো হয়নি।
- `proxy.ts`-এ এই path-এর কোনো RBAC rule নেই; collector তার নিজস্ব session/guest authorization চালায়। Actual proxy source দিয়ে regression test-এ premature session-fetch/RBAC interception নেই নিশ্চিত করা হয়েছে।
- Registered order-এর `userId` অবশ্যই server session user ID-এর সমান হতে হয়। Guest token দিয়ে registered customer-এর order নেওয়া যায় না।
- Guest order-এ existing HMAC signed, expiring, order-bound payment-init token যাচাই বহাল। Tests-এ actual `createPaymentInitToken`/`verifyPaymentInitToken` functions চালানো হয়েছে, isolated test-only secret দিয়ে।
- Client payment ID নিষিদ্ধ। Server request ID-এর order/provider binding ও related payment ownership আগের মতোই আছে। Existing hardening regression tests-ও চালানো হয়েছে।
- Rate limiting ও body limits bypass করা হয়নি। Origin rejection-এর আগে body/session/order/event I/O হয় না—regression tests এটি assert করে।

## নিরাপদ reproduction ও verification

বাস্তব tunnel probes-এ শুধু `{}` পাঠানো হয়েছে, কোনো cookie/guest token/order ID নয়। Body validation ownership/Prisma lookup-এর আগে থেমে যায়; কোনো payment বা diagnostic-event record লেখা হয়নি। Dev server restart project-specific verified process tree-তেই সীমাবদ্ধ ছিল।

| পরীক্ষা | Fix-এর আগে | Fix-এর পরে |
|---|---|---|
| Tunnel same-origin POST `{}` | 403 `ORIGIN_REJECTED` | 400, origin rejection header নেই; invalid body প্রত্যাশিতভাবে rejected |
| Attacker Origin + forged forwarded headers, same tunnel | — | 403 `ORIGIN_REJECTED` |
| Actual handler, synthetic owner session/order + configured tunnel origin | 403; regression assertion `403 !== 204` | 204 |
| Actual handler, guest + real valid test-only signed token | — | 204 |
| Missing/foreign session, absent order, missing/tampered/expired/wrong-order guest token | — | 403 `OWNERSHIP_REJECTED`, zero event writes |

Live tunnel verification ইচ্ছাকৃতভাবে successful collector insert করেনি, কারণ existing database অপরিবর্তিত রাখতে বলা হয়েছে। Authorized 204 cases synthetic session/order/event storage-এর বিরুদ্ধে actual route handler চালিয়ে যাচাই করা হয়েছে; authenticated browser checkout success দাবি করা হচ্ছে না।

Final Payment Diagnostics suite (নতুন ৩৭টি regression-সহ): **৩১৭ pass, ০ fail, ০ skip**। Node 24.22.1 ও `--import tsx --test` দিয়ে `package.json`-এর `test:payment-diagnostics`-এর একই সাতটি test file চালানো হয়েছে। পূর্ণ `tsc --noEmit`: **PASS, exit 0**। পূর্ণ repository `eslint .`: **PASS, exit 0**। `git diff --check`: **PASS**। Test, TypeScript ও ESLint output স্থানীয় ignored `.next/frontend-origin-all-tests.txt`, `.next/frontend-origin-typecheck.txt` এবং `.next/frontend-origin-eslint.txt`-এ আছে; before-fix failure `.next/frontend-origin-before.txt`-এ।

## এই follow-up-এ পরিবর্তিত files

- `app/api/payment-diagnostics/frontend/route.ts`: origin helper ও safe fixed 403 reason headers।
- `lib/payment-control/frontend-origin.ts`: strict configured-origin validation।
- `tests/payment-frontend-origin.test.mjs`: failing-before/passing-after regression, forged headers, configuration, session/guest/ownership, actual proxy source tests।
- `tests/payment-diagnostics-hardening.test.mjs`, `tests/payment-diagnostics-security.test.mjs`: নতুন helper dependency test harness-এ যোগ।
- `package.json`: existing Payment Diagnostics suite-এ নতুন test file অন্তর্ভুক্ত।
- `docs/payment-diagnostics-operations.md`, এই রিপোর্ট: কারণ, test scope ও diagnostics ব্যাখ্যা।

আগের tasks-এর uncommitted changes সংরক্ষণ করা হয়েছে। এই follow-up-এ `.env`, auth/session implementation, payment verification/settlement/inventory logic বা existing database পরিবর্তন করা হয়নি। Commit/push/deploy হয়নি।
