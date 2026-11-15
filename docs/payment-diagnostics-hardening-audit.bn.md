# Deshi Plus Payment Diagnostics — deep audit ও hardening

তারিখ: ৩০ অক্টোবর ২০২৬, Asia/Dhaka। Scope: মূল repository `E:\Ecommerce\General\general_ecommerce`; EPS Sandbox, AIBL UAT ও existing diagnostics।

## ফলাফল ও Git baseline

Code hardening ও safe local verification সম্পন্ন। Production verdict **NO-GO**: authenticated browser UAT, অনুমোদিত live Sandbox/UAT, deployed egress visibility এবং operational controls এখনও যাচাই হয়নি। Build বা local capture-কে production readiness বলা হচ্ছে না।

| বিষয় | পর্যবেক্ষণ |
| --- | --- |
| Branch | `main` |
| Audit baseline | `0665ace59c34107af40156c24cd5649fb7e122a0` |
| কাজ শুরুর HEAD | একই commit; baseline থেকে committed diff শূন্য |
| শুরুর working tree | পরিষ্কার |
| কাজ শেষে HEAD | একই commit; changes review করার জন্য uncommitted |
| Commit / push / deploy | কোনোটিই করা হয়নি |
| Existing database / `.env` | পরিবর্তন করা হয়নি; existing database-এ test/migration চালানো হয়নি |

নিষিদ্ধ external tracing toolkit পড়া, reference বা ব্যবহার করা হয়নি। Provider settlement/verification modules, signed callbacks, transaction amount/reference checks, financial schema, inventory commit ও reconciliation business rules অপরিবর্তিত।

## যাচাই করা architecture

Installed Next.js 16.3.7 App Router, React 19, Prisma 6.19.3/PostgreSQL, NextAuth JWT ও database-backed global/warehouse RBAC আছে। Installed Next route handlers, server/client boundary, env-variable ও CLI/typegen docs পড়ে পরিবর্তন করা হয়েছে।

Flow: checkout → existing provider initialization → safe server PaymentEvent/optional transport observer → best-effort browser collector → read-only repeatable-read investigation → global-manager dashboard/export। Capture আলাদা standalone process; Next handler থেকে privileged executable/shell চলে না। Native fetch-এর global dispatcher প্রতিস্থাপন করা হয়নি।

Active migration path `prisma/migrations-release`। Legacy history পুরোপুরি mirror নয়: squashed baseline ও কিছু historical release SQL আলাদা। পাঁচটি payment-related mirrored migration আলাদাভাবে যাচাই হয়েছে; fresh disposable database-এ সব ২৫টি active release migration apply হয়েছে। Historical SQL বা migration metadata পাল্টানো হয়নি।

## Zero browser events: পাওয়া evidence

IDE-তে আগে খোলা downloaded JSON-এর শুধু diagnostic counts/settings পরীক্ষা করা হয়েছে; customer payload প্রকাশ করা হয়নি। Report generated UTC `2026-10-29T18:28:56.985Z`: version 1, server events 73, client events 0, order-only browser reports 0, transport attempts 0, storage `NOT_COLLECTED`, `passiveDiagnosticsEnabled=false`, query limited false।

এটি report তৈরির process-এ browser collection disabled থাকার সরাসরি evidence। আগের checkout-এর সময় কোন browser bundle/flags চলছিল বা navigation/retention/storage failure হয়েছিল কি না, এই JSON থেকে নিশ্চিত নয়। Null-payment binding defect-ও zero-event root cause হিসেবে একা প্রমাণিত নয়: baseline reader একই server request ID দিয়ে কিছু pre-claim evidence উদ্ধার করতে পারত।

Audit-এর সময় `.env`-এ দুই browser flags true পাওয়া গেছে; file পরিবর্তন করা হয়নি। Running process/browser bundle restart বা rebuild হয়েছিল কি না UI দিয়ে যাচাই করা যায়নি। Current flag value দিয়ে পুরোনো event তৈরি বা backfill করা হয়নি।

Shell default Node `24.13.0`, native Undici `7.18.2`। Existing instrumented gate-এর জন্য এগুলো যথেষ্ট নয়। Tests/build-এ explicitly cached Node `24.22.1`, native Undici `7.30.1`, pinned connector Undici `6.29.1` ব্যবহার হয়েছে। Global runtime upgrade করা হয়নি। Deployment-এর actual runtime আলাদাভাবে যাচাই করতে হবে।

Baseline source `git show 0665ace59:...` দিয়ে offline VM-এ চালিয়ে আরও নিশ্চিত হয়েছে: REFUNDED/UNPAID verdict PASS, প্রথম transient write failure-এ দুই queued item dropped, same browser report দুবারে দুই record/null-attempt link, এবং app evidence directory না থাকায় agent gate failure। কোনো checkout/DB/network call ছাড়াই reproduction হয়েছে। Local পুনরুৎপাদন script: `E:\Ecommerce\General\general_ecommerce\.next\payment-hardening-baseline-repro.mjs`; `node --import tsx .next/payment-hardening-baseline-repro.mjs`।

## Findings, reproduction ও fixes

### P1-BROWSER-01 — report attribution, duplicate ও storage acknowledgement

| Field | বিবরণ |
| --- | --- |
| Severity / status | P1 — **FIXED**; browser delivery inherently best effort |
| Evidence | [collector POST](E:/Ecommerce/General/general_ecommerce/app/api/payment-diagnostics/frontend/route.ts:38), [browser report](E:/Ecommerce/General/general_ecommerce/lib/payment-control/browser-diagnostics.ts:9) |
| Root cause | Baseline unordered first server event-এর paymentId null হতে পারত; duplicate suppression ছিল না। `recordPaymentEvent` persistence error swallow করায় collector 204 দিতে পারত। Side request-এর 2-second abort valid keepalive delivery-ও শেষ করে দিতে পারত। |
| Reproduction / expected | একই request ID-তে আগে null-payment initiator, পরে linked INITIALIZE রাখুন; একই browser report দুবার পাঠান। Expected: valid order/provider/attempt link, এক persisted event; storage failure-এ truthful unavailable response। |
| Fix | Attempt relation server-side validate করে linked row preference; invalid request/report UUID ও client paymentId reject; deterministic hashed primary key ও `createMany(skipDuplicates)`; exact origin/owner/signed guest verifier/rate limits বজায়; direct persistence failure/logging-off → 503; bounded JSON keepalive side request checkout অপেক্ষা করে না, premature client abort সরানো হয়েছে। HTTP LAN origin-এ secure-context randomUUID না থাকলেও server nonce-less fallback দিয়ে report যায়। |
| Tests | `npm run test:payment-diagnostics`; native PostgreSQL collector → persistence → investigation visibility; concurrent duplicate once; foreign owner/order/request, malformed IDs, guest verifier, origin/rate/storage failure rejection PASS। |
| Remaining risk | Browser quota, navigation, extensions, offline/crash এবং untrusted client reports; historical missing evidence পুনর্গঠন নয়। Requestless order reports nonce দিয়ে dedup; legacy nonce-less client order/code/minute bucket ব্যবহার করে। |

### P1-TRANSPORT-02 — runtime/flag readiness ও unavailable stage

| Field | বিবরণ |
| --- | --- |
| Severity / status | P1 — code **FIXED**; deployed runtime/transport enablement **NOT_TESTED** |
| Evidence | [readiness](E:/Ecommerce/General/general_ecommerce/lib/payment-control/diagnostic-readiness.ts:6), existing [transport gate](E:/Ecommerce/General/general_ecommerce/lib/payment-control/transport-config.ts:25) |
| Root cause | Investigation UI/report-এ existing mode/storage/approval/runtime/allowlist blockers একসঙ্গে দেখা যেত না। Default shell runtime existing approval gate পাস করে না। |
| Reproduction / expected | public flag off, storage off, no approval, old Node অথবা proxy configuration দিন। Expected: explicit blocker; missing timings শূন্য/observed হিসেবে fabricated নয়। |
| Fix | Secret-free readiness snapshot: browser server/public/logging state; Node/native Undici; mode/reason, scope allowlists, storage/approval booleans, passive handshake limitations; browser UI নিজের compiled public flag-ও দেখায়। Existing strict runtime/proxy/TLS guards অপরিবর্তিত। |
| Tests | Real loopback trusted TLS, OS localhost DNS success, TCP establish/refusal, HTTP timeout, reuse/concurrency ও native-fetch dispatcher isolation PASS। Controlled injected resolver DNS failure PASS; no fabricated TCP/TLS timings। Simulated OS-event TCP timeout test PASS। |
| Remaining risk | Actual dropped-SYN TCP timeout **NOT_TESTED**: deterministic loopback test-এ OS firewall/drop rules বদলানো হয়নি। Privileged dedicated-host fault injection operator approval প্রয়োজন। Passive mode full handshake timing দেয় না। |

### P1-CAPTURE-03 — packet-to-payment attribution

| Field | বিবরণ |
| --- | --- |
| Severity / status | P1 — **PARTIAL**, inherent visibility limit transparently implemented |
| Evidence | [captureCorrelation](E:/Ecommerce/General/general_ecommerce/lib/payment-control/capture-correlation.ts:5), [packet metadata](E:/Ecommerce/General/general_ecommerce/lib/payment-control/pcapng.ts:128), [upload summary](E:/Ecommerce/General/general_ecommerce/app/api/payment-diagnostics/capture-agent/[id]/route.ts:60) |
| Root cause | Gateway-IP/time-window capture ও server request label exact packet ownership প্রমাণ করে না। Existing transport connection UUID PCAP stream/socket tuple-এর join key নয়। |
| Reproduction / expected | একই connection UUID-সহ দুটি overlapping request দিন। Expected: দুই candidate থাকতে পারে; কোনোটিকে exclusive payment owner বলা যাবে না। |
| Fix | Sanitized PCAP থেকে first/last interface UTC; bounded request/attempt/connection overlap candidates, limit flag; `TIME_WINDOW_ONLY` অথবা timestamp না থাকলে `UNKNOWN`। UI/JSON/PDF/CSV-তে limitations; `REQUEST_ATTRIBUTED`/`CONNECTION_CORRELATED` emitted হয় না। |
| Tests | Shared-connection/overlap/no-timestamp regression PASS; actual loopback capture PASS: 358 packets, 27,772 derived bytes, payload removed, zero TShark retransmission observations, temporary raw files cleaned। |
| Remaining risk | NAT, independent capture host, clock skew ও shared connections unverified। Derived file SHA-256 byte integrity দেয়; original wire provenance/signature নয়। Removed payload/options-এর কারণে header checksums wire-valid নয়; checksum corruption/packet-loss শতাংশ দাবি নেই। |

### P1-CAPTURE-04 — upload/lease concurrency ও stale readiness

| Field | বিবরণ |
| --- | --- |
| Severity / status | P1 — **FIXED** |
| Evidence | [claimCaptureJob](E:/Ecommerce/General/general_ecommerce/lib/payment-control/capture.ts:66), [completion ownership](E:/Ecommerce/General/general_ecommerce/app/api/payment-diagnostics/capture-agent/[id]/route.ts:56) |
| Root cause | Admission/sole-agent running check-এ UPLOADING বাদ ছিল। Completion unconditional update করত; upload চলাকালে janitor/lease transition হলে failed record COMPLETE হতে পারত। Readiness-এ current IP policy digest binding ছিল না। |
| Reproduction / expected | RUNNING → UPLOADING রেখে দ্বিতীয় job claim; অথবা file save চলাকালে lease FAILED করুন। Expected: parallel claim নেই; completion 409, failed lease বজায়, derived file cleanup। Approved IP বদলালে নতুন readiness লাগবে। |
| Fix | Queue capacity ও sole-agent ownership-এ UPLOADING; completion conditional updateMany with agent/status/expiry/start deadline; upload read deadline 10 sec; provider/port/IP digest-যুক্ত recent readiness; success/failure/rate-limit responses no-store। |
| Tests | Actual disposable PostgreSQL concurrency, upload sanitation/storage, scope change, stale lease ও upload-midflight failure simulation PASS। Expired lease resurrect হয় না; lost-lease file removed। |
| Remaining risk | Agent/control-plane clocks ও OS/interface deployment configuration operator-owned; lease failure diagnostic job fail করে, financial state নয়। |

### P2-AGENT-05 — application storage থেকে agent startup আলাদা

| Field | বিবরণ |
| --- | --- |
| Severity / status | P2 — **FIXED** |
| Evidence | [separate enablement gate](E:/Ecommerce/General/general_ecommerce/lib/payment-control/capture-policy.ts:31), [standalone agent](E:/Ecommerce/General/general_ecommerce/scripts/payment-capture-agent.ts:9), [protected temp root](E:/Ecommerce/General/general_ecommerce/scripts/lib/payment-capture-runner.ts:8) |
| Root cause | Agent startup app-side persistent evidence directory চাওয়া `requireCaptureEnabled()` ব্যবহার করত। |
| Reproduction / expected | Valid dedicated agent config দিন, app evidence directory omit করুন। Expected: agent controlled loopback control-plane-এ authenticate/poll করতে পারে; app নিজের persistent storage এখনও চায়। |
| Fix | `requireCaptureAgentEnabled` retains flags/TLS/limits; app wrapper retains persistent evidence requirement। Agent protected absolute temp root ব্যবহার করে; public/symlink root reject; safe startup error code প্রকাশ, raw error/path নয়। |
| Tests | Actual agent subprocess → authenticated fake loopback control-plane startup PASS, app evidence env absent; no capture job/raw file from heartbeat। Existing process timeout/output/cleanup tests ও real Dumpcap/TShark runner PASS। |
| Remaining risk | Existing NTFS ACL, Npcap capture permission/service identity deployment-এ যাচাই হয়নি। Unix mode Windows ACL নয়। Heartbeat packet visibility নয়; zero-packet readiness explicitly separate। |

### P2-CONSISTENCY-06 — unexamined state ও empty evidence-এ PASS

| Field | বিবরণ |
| --- | --- |
| Severity / status | P2 — **FIXED** |
| Evidence | [compatibility matrix](E:/Ecommerce/General/general_ecommerce/lib/payment-control/consistency.ts:19), [inventory checks](E:/Ecommerce/General/general_ecommerce/lib/payment-control/consistency.ts:62) |
| Root cause | Baseline CAPTURED-এর দুটি special case ছাড়া প্রায় সব state PASS করত। Empty stock/totals ও non-captured reservation check-ও PASS হতে পারত। Current-catalog ledger match original commitment প্রমাণ করে না। |
| Reproduction / expected | REFUNDED payment + UNPAID order অথবা unknown enum; empty stock/totals; captured current-catalog-only match। Expected: FAIL/UNKNOWN/NOT_OBSERVED, unexamined PASS নয়। |
| Fix | Actual 6×3×9 enum matrix; compatible state-only PASS, asynchronous/refund WARNING, unknown states UNKNOWN; no implicit overall-success assertion। Empty/not-applicable evidence NOT_OBSERVED; snapshot-only ledger PASS; catalog match UNKNOWN, mismatch WARNING। |
| Tests | 162 matrix cases + unknown enum/no verification/no ledger/empty stock regressions PASS। Existing amount/reference/settlement/inventory guards অপরিবর্তিত। |
| Remaining risk | PASS মানে শুধু সংশ্লিষ্ট rule-এর validated invariant; missing verification পৃথক check। Failed/voided historical attempt-এর paid/refunded order অন্য attempt দিয়ে settle হতে পারে; summary থেকে নিশ্চিত না হওয়ায় UNKNOWN। |

### P2-INVENTORY-07 — original snapshot scope ও truncated ledger

| Field | বিবরণ |
| --- | --- |
| Severity / status | P2 — **FIXED** |
| Evidence | [snapshot inventory scope](E:/Ecommerce/General/general_ecommerce/lib/payment-control/investigation.ts:50), [bounded ledger](E:/Ecommerce/General/general_ecommerce/lib/payment-control/investigation.ts:101) |
| Root cause | Stock scope শুধু current order/catalog IDs থেকে আসত; original AIBL variant বদলে গেলে পুরোনো warehouse drift বাদ পড়ত। Truncated product/variant scope-এ original ledger completeness claim নিরাপদ নয়। |
| Reproduction / expected | Disposable settled AIBL order-এর variant edit, original stock reserved counter drift। Expected: original snapshot অনুযায়ী ledger comparison ও পুরোনো warehouse counter mismatch শনাক্ত। |
| Fix | Original snapshot variant/product/bundle IDs scope-এ union; relevant query scope truncated হলে ledger unobserved। Original snapshot বনাম current catalog certainty পৃথক থাকে। |
| Tests | Actual disposable PostgreSQL original-variant edit + original reserved drift detection PASS; multi-warehouse exactly-once settlement/ledger assertions PASS। |
| Remaining risk | EPS original durable inventory snapshot নেই; catalog-only ledger matching UNKNOWN। Latest reconciliation comparison historical, full transition ledger নয়। কোনো inventory repair করা হয় না। |

### P2-QUEUE-08 — transient write failure-এ পুরো batch loss

| Field | বিবরণ |
| --- | --- |
| Severity / status | P2 — **FIXED** for bounded recovery/disclosure; durability guarantee নেই |
| Evidence | [retry classification](E:/Ecommerce/General/general_ecommerce/lib/payment-control/transport-queue.ts:15), [bounded drain](E:/Ecommerce/General/general_ecommerce/lib/payment-control/transport-queue.ts:79), [health](E:/Ecommerce/General/general_ecommerce/lib/payment-control/transport-queue.ts:106) |
| Root cause | Baseline একটি write reject হলে current+remaining batch discard করত। Drop counters আগে থেকেই ছিল, কিন্তু investigation report-এ surfaced ছিল না; সব loss previously undetectable বলা সঠিক নয়। |
| Reproduction / expected | প্রথম item-এ retryable DB error, পরে recovery; permanent/exhausted item-এর পরে valid item। Expected: bounded retry, duplicate-safe recovery, অন্য item চেষ্টা, visible gap। |
| Fix | Allowlisted Prisma/SQL/network transient codes; max two retries, 250/1,000 ms backoff; unknown/permanent error no retry; failed item-only drop; queue limit 128 includes in-flight। Existing DB attempt-ID guard retained। Retry/recovery/drop counters, timestamps, current-process scope ও memory-only durability প্রকাশ। |
| Tests | Transient recovery → duplicate-safe insertion, exhausted/permanent error → following item persisted, overflow/scheduler failure/isolation/healthy payment result regressions PASS। |
| Remaining risk | Crash/restart/serverless freeze/other instance loss অজানা। Durable broker/fallback disk buffer যোগ করা হয়নি; raw sensitive payload buffer নেই। Counter থেকে lost payment ID অনুমান করা হয় না। |

### P2-CI-09 — automated release checks ও repository protection visibility

| Field | বিবরণ |
| --- | --- |
| Severity / status | P2 — **PARTIAL**: local implementation complete, hosted enforcement NOT_TESTED |
| Evidence | [workflow](E:/Ecommerce/General/general_ecommerce/.github/workflows/payment-diagnostics.yml:1), [CODEOWNERS](E:/Ecommerce/General/general_ecommerce/.github/CODEOWNERS:1), [migration verification](E:/Ecommerce/General/general_ecommerce/scripts/verify-payment-diagnostics-migrations.mjs:1) |
| Root cause | Baseline-এ `.github` workflow/CODEOWNERS ছিল না। Branch administration connector-এর অনুমতির বাইরে। |
| Fix | Two CI jobs: quality/offline/payment safety/controlled transport/disposable PG; isolated production build/privacy। Fresh checkout-এর Next global route types-এর জন্য `next typegen` precedes tsc। Node/actions SHA pinned, contents-read token, credential/cache persistence off; production/bank secrets, deploy ও privileged capture নেই। Payment-sensitive ownership nomination। |
| Tests / API evidence | Local YAML parse, pinned-action/read-only-token inspection PASS; referenced scripts/local checks PASS। GitHub rulesets GET → `[]`; classic branch-protection GET → 403 `Resource not accessible by integration`। Workflow push/run করা হয়নি। |
| Remaining risk | Required checks/reviews/code-owner enforcement/secret scanning enabled বলা যাচ্ছে না। Workflow code থাকা এবং branch protection চালু থাকা আলাদা। Owner approval ছাড়া permission/rule পরিবর্তন হয়নি। |

### P2-REPORT-10 — evidence completeness ও UI/report wording

| Field | বিবরণ |
| --- | --- |
| Severity / status | P2 — **PARTIAL**: code/export QA FIXED; authenticated UI NOT_TESTED |
| Evidence | [investigation v2](E:/Ecommerce/General/general_ecommerce/lib/payment-control/investigation.ts:143), [dashboard](E:/Ecommerce/General/general_ecommerce/components/admin/payment-control/PaymentDiagnostics.tsx:100), [report exports](E:/Ecommerce/General/general_ecommerce/lib/payment-control/investigation-report.ts:13) |
| Root cause | Detail report-এ process queue health, deployment/runtime blockers, explicit attempt coverage ও retention gaps অনুপস্থিত ছিল। PDF timeline heading সব সময় complete retained window বলত। |
| Fix | V2 readiness, queueHealth, completeness, coverage, retention limits, reconciliation coverage ও packet candidates। PDF/CSV completeness/attribution text; PDF timeline bounded sample বলে। UI compiled-public-flag, zero-packet readiness, heartbeat limitation, dropped counters ও retention দেখায়; aborted UI fetch late result উপেক্ষা করে। |
| Tests | JSON hashing, formula-safe CSV, parseable PDF, redaction/RBAC/audit/retention tests PASS। Synthetic 3-page PDF text labels parsed; first/last page visually readable, no clipping। Full TypeScript/ESLint/build PASS। |
| Remaining risk / blocker | Chrome UI control tool: `Computer Use was not approved to use Google Chrome`। তা bypass করা হয়নি। Actual authenticated dashboard clicks/download/permission presentation staging-এ manual UAT প্রয়োজন। |

## চালানো tests ও actual results

Overlap-যুক্ত baseline/targeted rerun যোগ করে inflated total করা হয়নি। নিচের final broad suite + separate native PG + actual capture মিলিয়ে **725 PASS, 0 FAIL, 15 SKIPPED** (740 test records; parent subtests Node runner-এর নিজস্ব count অনুযায়ী)।

| Check | Actual result |
| --- | --- |
| Before-change diagnostics/security/EPS/transport-hardening baseline | 95 PASS, 0 FAIL, 0 SKIPPED |
| Final combined diagnostics/transport/provider/order/inventory/bundle/inspector suites | 728 total: **713 PASS, 0 FAIL, 15 SKIPPED** |
| Final targeted hardening rerun | 185 PASS, 0 FAIL/SKIPPED; readiness wording/non-secure-context fallback-সহ; broad count-এর সঙ্গে আবার যোগ করা হয়নি |
| Fresh own PostgreSQL cluster | **11 PASS**, 0 FAIL/SKIPPED; 25 release migrations |
| Real bounded loopback Dumpcap/TShark integration | **1 PASS**, 358 packets, 27,772 derived bytes; retransmission observations 0 |
| TypeScript | tsc noEmit PASS; isolated build-এর TypeScript-ও enabled |
| Full repository ESLint | PASS |
| Prisma validate | PASS; validation database write নয় |
| Payment migration mirror checker | 5 checked, PASS; zero DB connections |
| Isolated Next production build | PASS, exit 0; types enabled; no ignoreBuildErrors |
| Artifact privacy verifier | 762 server NFT manifests checked, 0 private/environment/evidence references |
| PDF QA | 3 pages, required confidence/collection/attribution labels present; first/last page visually checked |
| Workflow syntax/local security inspection | PASS; GitHub-hosted execution NOT_TESTED |
| Git whitespace | PASS under repository's normal CRLF normalization |

Final build compile 62 sec, TypeScript 53 sec, 498 static pages generated; exit 0। Dummy `127.0.0.1:1` DB fallback messages expected: existing DB intentionally inaccessible ছিল, build ব্যর্থ হয়নি। Final capture/PG test-owned processes অবশিষ্ট নেই।

Broad command (Node 24.22.1; no application bootstrap/database fallback in test harnesses):

```powershell
node --import tsx --test tests/payment-diagnostics-hardening.test.mjs tests/payment-diagnostics.test.ts tests/payment-diagnostics-security.test.mjs tests/eps-diagnostics-regression.test.mjs tests/payment-transport.test.ts tests/payment-transport-boundary.test.mjs tests/payment-transport-hardening.test.mjs tests/payment-transport-connector-isolation.test.mjs tests/payment-transport-approval.test.mjs tests/payment-transport-local.test.mjs tests/payment-transport-build-boundary.test.mjs tests/aibl-wallet-callback.test.mjs tests/aibl-wallet-settlement.test.mjs tests/order-inventory-lifecycle.test.mjs tests/order-warehouse-stock.test.mjs tests/order-idempotency.test.mjs tests/admin-order-gateway-edit.test.mjs tests/pc-builder-checkout-lifecycle.test.mjs tests/warehouse-bundle-stock.test.mjs tests/configurable-bundles.test.mjs tests/payment-technical-inspector.test.mjs tests/payment-inspector-cli.test.mjs tests/payment-transport-postgres-target.test.mjs tests/payment-transport-postgres-integration.test.mjs
```

Payment safety coverage: successful EPS/AIBL settlement, amount/reference mismatch, duplicate callback/verification, refund protection, reservation commit/release, bundle/warehouse stock, concurrent two-warehouse exactly-once settlement, post-write exception transaction rollback। Native test notification/commission/reporting side effects controlled stubs; bank HTTP mocked। Code tests live gateway verification নয়।

একটি intermediate native run-এ পুরোনো EPS diagnostic expectation `PASS` নতুন current-catalog rule-এ `UNKNOWN` হওয়ায় assertion fail করেছিল। শুধু diagnostic expectation সংশোধন হয়েছে; captured/paid state, warehouse deductions, reservation/ledger ও race assertions বহাল। Final native run PASS।

১৫টি SKIPPED হলো existing strict transport PostgreSQL integration-এর dedicated `gen_eco_transport_uat`, localhost:5432 ও explicit credential target অনুপস্থিত থাকার কারণে। Guard শিথিল করে `gen_eco` বা random existing DB ব্যবহার করা হয়নি। নতুন native suite নিজে random role/free loopback port দিয়ে initdb করে; actual server data_directory মিলিয়ে তারপর write করে; শেষে stopped owned cluster cleanup করে।

Ignored local QA evidence: `E:\Ecommerce\General\general_ecommerce\.next\payment-hardening-regressions-final.txt`, `payment-hardening-postgres.txt`, `payment-hardening-capture.txt`, `payment-hardening-build-final.txt`, `payment-hardening-build-final-exit.txt`, `payment-hardening-lint-final.txt`, `payment-hardening-prisma.txt` এবং `payment-hardening-pdf-qa`। এগুলো deployment artifact হিসেবে publish করা হয়নি।

## NOT_TESTED ও APPROVAL_REQUIRED

| বিষয় | Status / কারণ |
| --- | --- |
| Authenticated admin browser UAT | NOT_TESTED — Chrome control access denied; component/API tests browser UAT নয় |
| Live EPS Sandbox / AIBL UAT | NOT_TESTED; APPROVAL_REQUIRED — explicit account/test scenario/payment authorization নেই |
| Actual production/deployed gateway egress capture | NOT_TESTED; APPROVAL_REQUIRED — host/interface/IP scope/service permissions যাচাই দরকার |
| Real OS-dropped SYN/TCP timeout | NOT_TESTED; APPROVAL_REQUIRED — dedicated test host-এ approved network fault injection; simulated event আলাদাভাবে tested |
| GitHub classic branch protection | NOT_TESTED — connector 403; owner/admin read প্রয়োজন |
| Protection/permissions/secret scanning changes | APPROVAL_REQUIRED — কিছু পরিবর্তন করা হয়নি |
| Hosted CI / deployment / retention scheduler / NTFS ACL | NOT_TESTED; workflow/service provisioning owner-operated |

## Unsupported claims এড়িয়ে চলা

- Zero browser events মানেই collector code broken নয়; supplied v1 report runtime collection off দেখায়। Historical checkout flag/delivery cause নিশ্চিত নয়।
- State compatibility PASS overall financial verification নয়; bank verification/amount/ledger checks পৃথক।
- Interface-open বা heartbeat successful হলেও actual scoped traffic নাও থাকতে পারে।
- Stored capture requestId/operation exact packet/payment attribution নয়; overlapping shared connection-ও sufficient নয়।
- Queue আগেও process counters রাখত; durable delivery বা cross-instance completeness ছিল না, এখনও নেই।
- SHA-256 independent signature, bank confirmation, original wire checksum বা complete evidence নয়।
- Local tests/build/added workflow production readiness, active branch protection বা hosted CI success প্রমাণ করে না।

## পরিবর্তিত files

নতুন:

- `E:\Ecommerce\General\general_ecommerce\.github\workflows\payment-diagnostics.yml`
- `E:\Ecommerce\General\general_ecommerce\.github\CODEOWNERS`
- `E:\Ecommerce\General\general_ecommerce\lib\payment-control\diagnostic-readiness.ts`
- `E:\Ecommerce\General\general_ecommerce\lib\payment-control\capture-correlation.ts`
- `E:\Ecommerce\General\general_ecommerce\scripts\verify-payment-diagnostics-migrations.mjs`
- `E:\Ecommerce\General\general_ecommerce\tests\payment-diagnostics-hardening.test.mjs`
- `E:\Ecommerce\General\general_ecommerce\docs\payment-diagnostics-hardening-audit.bn.md`

সংশোধিত (সব path-এর root `E:\Ecommerce\General\general_ecommerce`):

| Area | Files |
| --- | --- |
| Browser/API | `E:\Ecommerce\General\general_ecommerce\lib\payment-control\browser-diagnostics.ts`; `E:\Ecommerce\General\general_ecommerce\app\api\payment-diagnostics\frontend\route.ts` |
| Capture API | `E:\Ecommerce\General\general_ecommerce\app\api\payment-diagnostics\capture-agent\route.ts`; `E:\Ecommerce\General\general_ecommerce\app\api\payment-diagnostics\capture-agent\[id]\route.ts`; `E:\Ecommerce\General\general_ecommerce\app\api\admin\payment-control\diagnostics\captures\route.ts` |
| Capture policy/agent | `E:\Ecommerce\General\general_ecommerce\lib\payment-control\capture-policy.ts`; `E:\Ecommerce\General\general_ecommerce\lib\payment-control\capture.ts`; `E:\Ecommerce\General\general_ecommerce\lib\payment-control\pcapng.ts`; `E:\Ecommerce\General\general_ecommerce\scripts\payment-capture-agent.ts`; `E:\Ecommerce\General\general_ecommerce\scripts\lib\payment-capture-runner.ts` |
| Investigation | `E:\Ecommerce\General\general_ecommerce\lib\payment-control\consistency.ts`; `E:\Ecommerce\General\general_ecommerce\lib\payment-control\investigation.ts`; `E:\Ecommerce\General\general_ecommerce\lib\payment-control\diagnostic-overview.ts`; `E:\Ecommerce\General\general_ecommerce\lib\payment-control\investigation-report.ts` |
| Transport queue | `E:\Ecommerce\General\general_ecommerce\lib\payment-control\transport-queue.ts`; `E:\Ecommerce\General\general_ecommerce\lib\payment-control\transport-storage.ts`; `E:\Ecommerce\General\general_ecommerce\lib\payment-control\transport-types.ts` |
| UI | `E:\Ecommerce\General\general_ecommerce\components\admin\payment-control\PaymentDiagnostics.tsx` |
| Tests | `E:\Ecommerce\General\general_ecommerce\tests\payment-diagnostics-postgres.test.mjs`; `E:\Ecommerce\General\general_ecommerce\tests\payment-diagnostics-security.test.mjs`; `E:\Ecommerce\General\general_ecommerce\tests\payment-transport-hardening.test.mjs`; `E:\Ecommerce\General\general_ecommerce\tests\payment-transport-local.test.mjs` |
| Operations | `E:\Ecommerce\General\general_ecommerce\package.json`; `E:\Ecommerce\General\general_ecommerce\docs\payment-diagnostics-operations.md` |

## Security ও database impact

নতুন schema/migration/dependency নেই। Browser collector existing PaymentEvent-এ sanitized, duplicate-safe diagnostic rows লেখে; capture/audit/retention existing diagnostic records/files ব্যবহার করে। Investigation financial queries read-only থাকে। Financial correction, settlement retry, amount/reference alteration, callback/idempotency bypass বা gateway call যোগ হয়নি।

Dedicated global capture/export/evidence grants, non-banned manager gate, exact-origin mutations, bounded rate limits, fail-closed ActivityLog, no-store downloads, CSV formula neutralization এবং explicit projection/redaction retained। New readiness কখনও secret values, destination IP list, filesystem paths বা credentials ফেরত দেয় না। Packet files network headers বহন করে; restricted permission/private volume/retention এখনও আবশ্যক।

## Manual staging verification

সঠিক Node 24.22.1 shell ব্যবহার করুন। Existing `.env` edit বা current `gen_eco`-তে test writes করবেন না। নিচের infrastructure-writing tests নিজেদের disposable cluster/fixture তৈরি করে।

```powershell
node -p "JSON.stringify({node:process.versions.node,undici:process.versions.undici})"
npm run check:payment-transport:runtime
npm run test:payment-diagnostics
npm run test:payment-safety
npm run test:payment-transport
npm run test:payment-transport:local
npm run validate:schema
npm run verify:payment-diagnostics:migrations
npm run lint
npm run typecheck
npm run build:payment-diagnostics:verify
npm run verify:payment-diagnostics:artifacts
```

Expected: compatible runtime, tests exit 0, five mirror checks, schema/type/lint/build success, privacy count 0। Fresh checkout-এ typecheck-এর আগে `npx next typegen` চালান। Old default Node 24.13-তে runtime check nonzero হওয়া expected blocker; guard bypass করবেন না।

```powershell
$env:PAYMENT_DIAGNOSTICS_LOCAL_POSTGRES='true'
$env:PAYMENT_DIAGNOSTICS_TEST_PG_BIN='C:\Program Files\PostgreSQL\17\bin'
npm run test:payment-diagnostics:postgres
```

Expected: new temporary data directory identity verified, 25 migrations, 11 PASS, clean shutdown/cleanup। Script existing `DATABASE_URL` বা `.env` fallback ব্যবহার করে না।

```powershell
& 'C:\Program Files\Wireshark\dumpcap.exe' -D
$env:PAYMENT_CAPTURE_LOCAL_UAT='true'
$env:PAYMENT_CAPTURE_DUMPCAP='C:\Program Files\Wireshark\dumpcap.exe'
$env:PAYMENT_CAPTURE_TSHARK='C:\Program Files\Wireshark\tshark.exe'
$env:PAYMENT_CAPTURE_TEST_INTERFACE='<this run-এর verified loopback number>'
npm run test:payment-capture:local
```

Expected: only own 127.0.0.1:443 TLS fixture, nonzero packets, no payload in derived file, successful integrity/cleanup। Interface ID hardcode করবেন না: এই run-এ loopback 8; আগের run-এ 9। Port occupied হলে existing listener না থামিয়ে test SKIPPED হবে। New OS privilege লাগলে operator approval ছাড়া এগোবেন না।

Approved isolated staging browser UAT:

1. Dedicated test database/fixture, correct global RBAC ও HTTPS/origin নিশ্চিত করুন; existing account/database-এ diagnostic fixture seed নয়। Server/public diagnostics flags ও event logging staging process-এ enable করে rebuild/restart; capture OFF। `.env` file পরিবর্তন পৃথক approval-এর বিষয়।
2. Unauthenticated/warehouse-only staff-এ diagnostics/export/capture/evidence access denied দেখুন; manager read-only access ও dedicated independent grants যাচাই করুন।
3. Controlled mocked initialization থেকে browser রিপোর্ট পাঠান; Network panel-এ same-origin collector 204, diagnostics detail-এ CLIENT_REPORTED + attempt coverage বৃদ্ধি দেখুন। Requestless failure order-only থাকবে; দুইবার same request/code এক event। No-bank controlled fixture-ই ব্যবহার করুন।
4. Collector block/offline/503 হলেও original request একবারই হয়, response/redirect ফল অপরিবর্তিত থাকে দেখুন। অন্য owner/order/request ID 400/403; origin mismatch 403; rate limit 429।
5. JSON/PDF/CSV export: no-store, audit row, safe fields, v2 completeness; JSON report payload SHA ও actual downloaded-file SHA তাদের আলাদা documented scope-এ verify করুন। PCAPNG dedicated grant ছাড়া deny।
6. Capture অনুমোদিত host-এ operator-verified public gateway IP scope ও private storage/agent account configure করে Test readiness করুন। Heartbeat, interface opened ও trafficObserved আলাদা দেখুন; destination policy বদলালে readiness পুনরায় লাগবে। Bank request তৈরি না করে idle zero-packet result-কে traffic visibility বলবেন না।
7. Explicitly authorized EPS Sandbox/AIBL UAT scenario ছাড়া real initialization/status/verification/callback test চালাবেন না। Authorization হলে UTC trace/request IDs, bank-provided test account/approved amount, expected callback এবং existing verification result লিখে compare করুন; diagnostic evidence থেকে কখনও paid/captured update নয়।

## Release prerequisites ও rollback

Prerequisites: reviewed deployment target/migration drift; clean Prisma generation; approved Node/native Undici; assigned RBAC; private persistent app evidence volume ও protected agent scratch ACL; minimal separate service privileges; approved destination/interface scope; distributed rate limiting; retention scheduler; authenticated browser UAT; authorized bank UAT; hosted CI success। Instrumented transport-এর explicit approval/allowlists/proxy review আলাদা; capture enablement দিয়ে তা অনুমোদন হয় না।

Repository owner approval নিয়ে main-এ minimum two PR reviews, code-owner approval, stale-review dismissal, conversation resolution, up-to-date required checks `Payment quality and offline safety` ও `Payment isolated build and artifact privacy`, force-push/deletion restriction এবং protected release environment reviewers প্রস্তাব করা হচ্ছে। Secret scanning/push protection availability owner যাচাই করবেন। কোনো rule এখন enabled বলে দাবি নয়।

Rollback: server/public diagnostics ও capture OFF করে rebuild/restart, standalone agent orderly stop, reviewed previous application revision deploy করুন। Additive baseline capture table/index রেখে দিন; financial DB reset/downgrade/repair নয়। Current hardening-এ schema migration না থাকায় নতুন rollback SQL নেই। V2 report consumers-কে version-aware রাখুন। Outstanding evidence তার authorized retention policy অনুযায়ী পরিষ্কার হবে; user/customer data blind deletion নয়।

## Technical references

- [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use): immutable action pinning ও least-privilege workflow guidance।
- [Official setup-node](https://github.com/actions/setup-node): runtime setup; exact v7 commit API দিয়ে যাচাই করে pin করা হয়েছে।
- [Node process versions](https://nodejs.org/api/process.html): runtime/native dependency versions-এর অর্থ; actual versions local process থেকে পড়া হয়েছে।
- Installed Next docs এবং existing [operations guide](E:/Ecommerce/General/general_ecommerce/docs/payment-diagnostics-operations.md) relevant rollout details দেয়।

Verdict: **local hardening verified; production NO-GO until listed UAT, runtime and operational prerequisites are satisfied**।
