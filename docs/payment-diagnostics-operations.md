# Deshi Plus Payment Diagnostics — পরিচালনা ও rollout

Frontend collector-এর ngrok 403 fix ও নিরাপদ reproduction: [payment-diagnostics-frontend-origin-fix.bn.md](payment-diagnostics-frontend-origin-fix.bn.md)। Collector এখন internal request origin-এর পাশাপাশি বিদ্যমান configured public origin-এর পূর্ণ scheme/host/port মেলায়। `Host`/`Forwarded`/`X-Forwarded-*` দিয়ে origin authorization হয় না। Empty 403-এর `X-Payment-Diagnostic-Reason` header-এ `ORIGIN_REJECTED` অথবা generic `OWNERSHIP_REJECTED` পাওয়া যায়; কোনো token, cookie, customer বা order value প্রকাশ করা হয় না।

সর্বশেষ hardening audit: [payment-diagnostics-hardening-audit.bn.md](payment-diagnostics-hardening-audit.bn.md)। নিচের flags উদাহরণ; audit কোনো `.env` পরিবর্তন করেনি। Existing account/production configuration-এর অনুমোদন এই উদাহরণ দেয় না।

Investigate-এর dev-only HTML 404 fix: [payment-diagnostics-route-404-fix.bn.md](payment-diagnostics-route-404-fix.bn.md)। Next 16.3.7-এর partial Watchpack startup scan-এর জন্য `predev`/`postinstall`-এ version/source-hash guarded dev backport আছে। `npm run dev` ব্যবহার করুন; patch প্রয়োগের আগে চালু server restart করতে হবে। কেবল cache corruption ধরে cache delete করা এই fix নয়। Upstream fixed release-এ startup guard থাকলে installer backport প্রয়োগ করে না; unknown vendor source/version-এ review ছাড়া replace করে না।

Routing regression: `npm run test:payment-diagnostics:routes` actual দুই GET handler-এর isolated Next dev app চালায়, controlled partial-scan input দেয় এবং synthetic roles/services দিয়ে HTTP 200/400/401/403/404 + Content-Type পরীক্ষা করে। Application database, `.env`, bank endpoint বা real customer session ব্যবহার হয় না। Fixture/owned server শেষে cleanup হয়।

## অডিট ও নকশা

কাজ হয়েছে মূল `general_ecommerce` repository-র `main` branch-এ। শুরুর working tree পরিষ্কার ছিল। নিষিদ্ধ পুরোনো toolkit-এর কোনো source, architecture বা repository পড়া হয়নি।

বাস্তব stack: Next.js App Router (installed 16.3.7), React 19, TypeScript, Prisma 6.19.3/PostgreSQL, NextAuth JWT session এবং database-backed global/warehouse RBAC। `prisma.config.ts`-এর active migration history `prisma/migrations-release`; `prisma/migrations`-এ একই নতুন SQL-এর mirror রাখা হয়েছে। Deployment provider নিশ্চিত করার deployment manifest পাওয়া যায়নি; তাই Vercel/VPS সম্পর্কে অনুমান করা হয়নি।

অডিটের প্রধান source:

- `lib/eps.ts`, `app/api/eps/*`, `lib/eps-callback.ts`: EPS Sandbox, HMAC authentication, signed callback correlation, exact `Success`, reference/amount validation, Order lock, reservation commit ও idempotent settlement।
- `lib/aibl-wallet.ts`, `lib/aibl-wallet-callback.ts`, `lib/aibl-wallet-http.ts`: AIBL UAT, TOKEN/OrderID/VERIFY, strict callback parsing, original initialization/inventory snapshot, bank-reference protection ও atomic settlement। AIBL VERIFY-এ undocumented echoed amount/currency দাবি করা হয়নি।
- `app/ecommerce/checkout/page.tsx`, order route/idempotency helpers: browser validation, pending-attempt resume এবং duplicate submission guards।
- `lib/inventory.ts`, `lib/order-inventory-lifecycle.ts`, warehouse/bundle modules: reservation, commit, restoration, physical variants, preassembled এবং component bundles।
- `lib/payment-control/*`, `lib/network-monitor/*`: existing events, comparisons, disputes, request inspector, bounded optional transport evidence, host/probe context।
- `lib/auth.ts`, `lib/rbac.ts`, `lib/rbac-config.ts`, `lib/admin-order-editor.ts`: staff authorization ও gateway payment fields-এর read-only protection।
- Existing payment/inventory tests, cron routes, `next.config.ts`, Prisma schema এবং release migrations।

পাওয়া ঘাটতি: attempt-level investigation/trace view ছিল না; confidence-based cross-evidence findings ও broad read-only consistency report ছিল না; restricted packet capture queue/agent/export ছিল না; bank-ready JSON/PDF evidence manifest ছিল না। EPS init response-এ AIBL-এর মতো request correlation header ছিল না। Existing checkout index-এর regression test একটি অনুপস্থিত historical migration নির্দেশ করছিল; active squashed baseline-এ index-টিও ছিল না। নতুন additive index migration এবং বর্তমান stronger payment-result guard অনুযায়ী দুটি stale test reference সংশোধন করা হয়েছে।

নতুন OpenTelemetry backend, message broker বা tracing vendor যোগ করা হয়নি। Existing request IDs, explicit safe event projection, transport observer এবং PostgreSQL diagnostics queue এই একক application-এর জন্য যথেষ্ট ছোট operational surface দেয়। Capture process সম্পূর্ণ আলাদা; Next.js handler থেকে shell বা capture executable চালানো হয় না।

Provider diagnostic adapters আলাদা। Existing AIBL `/verify` HTTP operation telemetry-তে `STATUS_QUERY` নামে recorded হয়; নতুন adapter সেটিকে `VERIFY_REQUEST` হিসেবে ব্যাখ্যা করে এবং original recorded operation-ও রাখে। EPS-এর একই recorded operation-এর অর্থ `STATUS`। এই interpretation-এর জন্য কোনো provider request/verification implementation বদলানো হয়নি।

## পরিচয়, observation ও অর্থের নিরাপত্তা

প্রতিটি persisted Payment attempt-এর স্থায়ী diagnostic UUID: `d3500000-0000-4000-8000-<internal payment id-এর ১২ অঙ্কের hex>`। এটি opaque authorization token নয়; একটি reversible internal correlation identifier। একই attempt-এর callback/reconciliation-এর request ID আলাদা হতে পারে; attempt trace একই থাকে। Financial row backfill বা update করে trace বসানো হয়নি।

AUTH/TOKEN attempt row তৈরির আগে হতে পারে। Reader একই server-generated request ID-এর মাধ্যমে সেই evidence উদ্ধার করে। কেবল order/time proximity দেখে evidence অন্য attempt-এ লাগানো হয় না। Payment row তৈরির আগেই ব্যর্থ request existing request inspector/network history-তে তদন্ত করতে হবে; nonexistent payment attempt-এর trace বানানো হয় না।

Read-only investigation একটি `REPEATABLE READ` transaction-এ `SET TRANSACTION READ ONLY` ব্যবহার করে। এর মধ্যে gateway call, settlement, inventory repair বা financial row lock নেই। Statement deadline আছে। Transport/capture reads আলাদাভাবে bounded। নতুন capture table unavailable হলেও financial snapshot/report কাজ করতে পারে; capture availability `UNAVAILABLE` হবে।

নতুন code EPS/AIBL provider success rules, account binding, signed state, transaction-ID protection, duplicate capture guard, inventory commit, refund/reconciliation policy বা admin payment editing rules পরিবর্তন করে না। Instrumented transport-এর existing separate approval gate বজায় আছে। Capture service offline হলে checkout তাতে নির্ভর করে না। নতুন browser collection best effort; checkout তার জন্য অপেক্ষা বা payment retry করে না।

`CONFIRMED` মানে নির্দিষ্ট observed failure/invariant breach-এর evidence পাওয়া গেছে। এটি bank internal root cause নিশ্চিত করে না। Timeout-এ gateway charge সম্পন্ন করেও থাকতে পারে। Callback receipt payment verification নয়। Repeated callbacks duplicate charge বা malicious replay প্রমাণ করে না। Historical authorization/transition ledger না থাকলে সংশ্লিষ্ট check `UNKNOWN`/`NOT_OBSERVED` থাকবে।

## Dashboard ও access

Route: `/admin/payment-control/diagnostics`। Existing Payment Control Center-এ link আছে।

সব read API-তে existing authenticated, non-banned global payment manager প্রয়োজন। Warehouse-only grant যথেষ্ট নয়। অতিরিক্ত permissions:

| Permission | কাজ |
| --- | --- |
| `payments.diagnostics.capture` | Readiness/capture job request |
| `payments.diagnostics.export` | JSON, CSV ও PDF report export |
| `payments.diagnostics.evidence` | Restricted PCAPNG download |

Existing RBAC provisioning workflow দিয়ে নতুন system permissions sync/assign করতে হবে। Database role grants এই কাজের সময় পরিবর্তন করা হয়নি। Sensitive export/capture request-এর durable `ActivityLog` write ব্যর্থ হলে action fail closed হবে। Mutation exact same-origin হতে হবে; reads, exports, capture submission এবং agent polling-এ পৃথক rate limits আছে। Production-এর existing distributed rate limiter configuration প্রয়োজন।

Dashboard overview-তে payment counts, captured/failed/pending, event-based HTTP/callback error rate, latency average/P50/P95/P99, reconciliation errors এবং open dispute investigations আছে। Open investigations হলো existing open dispute cases; নতুন case workflow invent করা হয়নি।

Coverage সৎভাবে দেখানো হয়: list-এর category/confidence/severity assessment latest 100 matching payments ও সর্বোচ্চ 100 events/attempt-এর মধ্যে সীমাবদ্ধ; full consistency/transport findings detail view-তে। Date range সর্বোচ্চ 90 days। HTTP/callback metrics provider/date scope-এর event observations; order/status search-এর full request denominator নয়। Latency latest 2,000 terminal HTTP observations-এর sample। Detail সর্বোচ্চ 1,000 lifecycle events, 100 related request IDs এবং প্রথম 20 request-এর সর্বোচ্চ 100 transport attempts/request পড়ে। Retention, ring rollover, queue loss ও logging-off অবস্থায় completeness নিশ্চিত নয়।

Success-rate numerator হলো current CAPTURED + REFUNDED attempts; refund-এর আগে successful capture বাদ দেওয়া হয় না। HTTP/transport failure rate HTTP business-success rate নয়। Missing stored bank reference-এ duplicate-reference check `NOT_OBSERVED`। Response না পাওয়া browser reports আলাদা **order-level** section-এ থাকে; সেগুলোকে নির্দিষ্ট attempt-এর সঙ্গে ভুলভাবে correlate করা হয় না। Original inventory snapshot না থাকলে current catalog-এর সঙ্গে ledger mismatch `WARNING`; catalog edit-কে confirmed historical commit bug বলা হয় না।

Checks: captured/order mismatch, duplicate settled attempts, stored bank-reference duplication, local amount/currency mismatch, retained provider verification, verified-but-unsettled state, captured order-এর leftover holds, provider-specific negative inventory ledger বনাম physical/bundle quantities, negative warehouse availability, reserved counters বনাম all active holds, variant aggregate stock drift, latest reconciliation issue। Missing historical ledger evidence fabricated PASS হয় না।

## Feature flags

`.env` পরিবর্তন করা হয়নি। নিচের নতুন switches default OFF:

```dotenv
PAYMENT_DIAGNOSTICS_ENABLED=false
NEXT_PUBLIC_PAYMENT_DIAGNOSTICS_ENABLED=false
PAYMENT_NETWORK_CAPTURE_ENABLED=false
PAYMENT_DIAGNOSTICS_RETENTION_DAYS=7
PAYMENT_DIAGNOSTICS_MAX_CAPTURE_SECONDS=30
PAYMENT_DIAGNOSTICS_MAX_CAPTURE_BYTES=1048576
```

Browser collection-এর জন্য server flag এবং public build-time flag দুটিই প্রয়োজন; public flag পরিবর্তনে rebuild দরকার। `PAYMENT_CONTROL_LOGGING_ENABLED=false` থাকলে collector 503 দেয়; success বলে event হারানো আড়াল করে না। অন্য telemetry/transport flags নিজে থেকে enable/disable করা হয়নি। Dashboard-এর Collection and runtime readiness card-এ server flag, actual browser-bundle flag, storage, Node/Undici compatibility ও instrumentation approval blockers দেখুন। Configuration-ready মানে collection প্রমাণিত নয়।

Browser request ছোট JSON `keepalive` fetch; redirect-এর আগে checkout তার completion-এর জন্য অপেক্ষা করে না। Request ID server event ও order/provider/attempt relation দিয়ে যাচাই হয়। Null-payment initiator-এর আগে নয়, linked attempt-কে অগ্রাধিকার দেওয়া হয়। Client payment ID reject হয়। Verified request/code-এর duplicate deterministic primary key + `createMany(skipDuplicates)` দিয়ে একবার persist হয়; order-only reports-এ nonce, legacy nonce-less reports-এ order/code/minute deduplication থাকে। কোনো token/customer field persist হয় না। Collection failure payment request পুনরায় চালায় না। Browser quota, navigation, extensions বা process loss-এর কারণে best-effort event এখনও হারাতে পারে।

Existing measured DNS/TCP/TLS চালাতে `docs/payment-transport-monitoring.md` এবং approval/readiness documentation অনুসরণ করুন। New capture flag দিয়ে instrumented HTTP connector অনুমোদিত হয় না। Certificate expiry কেবল available peer-certificate evidence থেকে সংরক্ষিত হয়; missing/resumed/legacy evidence-এ unavailable থাকতে পারে।

## Isolated capture agent

Agent payment egress দেখতে পাওয়া Ethernet/RAW interface-সহ local machine বা self-hosted VPS-এ চলবে। Serverless app-এর ephemeral filesystem-কে durable evidence storage ধরে enable করবেন না। Persistent private volume, suitable process host অথবা separately reviewed storage adapter ছাড়া capture OFF থাকবে। App/agent দুই জায়গার destination approval মেলাতে হবে। Agent কখনো gateway-তে test charge, HTTP probe বা payment retry পাঠায় না।

Server configuration:

```dotenv
PAYMENT_CAPTURE_AGENT_ID=payment-capture-host-1
PAYMENT_CAPTURE_AGENT_TOKEN=<separate random 32-256 character base64url token>
PAYMENT_DIAGNOSTICS_EVIDENCE_DIR=<absolute private persistent directory outside public>
PAYMENT_CAPTURE_GATEWAY_IPS_JSON={"EPS":["<operator-verified public IPv4>"],"AIBL_WALLET":["<operator-verified public IPv4>"]}
```

Placeholder IP JSON ব্যবহারযোগ্য policy নয়। Bank/operator থেকে gateway hostname-এর প্রকৃত বর্তমান public IPv4 যাচাই করে সর্বোচ্চ 8 addresses/provider দিন। Private, loopback, link-local, documentation, multicast ও অন্যান্য rejected address ranges গ্রহণ করা হয় না। Arbitrary hostname/URL, command, capture filter বা interface browser/API থেকে দেওয়া যায় না। Ethernet/RAW এবং IPv4 NULL/LOOP link formats parser গ্রহণ করে। Production target policy-তে loopback/IPv6 অনুমোদিত নয়; cooked/unsupported output fail closed হবে। Controlled loopback test lower-level runner ব্যবহার করে; production target approval শিথিল করে না।

Agent-এর minimal dedicated environment-এ একই enablement flags, limits, ID, token ও approved IP JSON দিন, সঙ্গে নিচের settings। Agent-এর জন্য app-side `PAYMENT_DIAGNOSTICS_EVIDENCE_DIR` প্রয়োজন নেই; সেটি শুধু application-এর persistent storage। Agent-এর `PAYMENT_CAPTURE_TEMP_DIR` পৃথক protected scratch storage। Public directory বা symlink temp root গ্রহণ করা হয় না।

```dotenv
PAYMENT_CAPTURE_APP_ORIGIN=https://<your-app-origin>
PAYMENT_CAPTURE_TEMP_DIR=<absolute private local temp directory>
PAYMENT_CAPTURE_DUMPCAP=<absolute path to dumpcap executable>
PAYMENT_CAPTURE_TSHARK=<absolute path to tshark executable>
PAYMENT_CAPTURE_INTERFACE=<approved numeric interface id from dumpcap -D>
```

শুধু local control-plane development-এর জন্য loopback HTTP origin গ্রহণযোগ্য। অন্য origin HTTPS হওয়া বাধ্যতামূলক। Redirect follow করা হয় না। Agent `.env` load করে না; gateway credentials তার প্রয়োজন নেই।

Node `>=24.22.1 <25` দিয়ে explicitly চালান:

```powershell
npm run payment:capture-agent
```

Windows-এ Wireshark/TShark, Dumpcap ও Npcap এবং capture permission প্রয়োজন। Evidence/temp directories-এর NTFS ACL service account ও authorized operators-এর মধ্যে সীমাবদ্ধ করুন; Unix mode flags Windows ACL-এর বিকল্প নয়। Linux-এ narrowly scoped capture capabilities/service identity ব্যবহার করুন। Entire Next.js application-কে capture privileges দেবেন না। Child processes fixed executable/argument array, `shell:false`, hidden window এবং minimal environment ব্যবহার করে; gateway secrets, `SSLKEYLOGFILE` ও `NODE_OPTIONS` child-এ যায় না। TShark TLS key file explicitly empty।

Flow: admin **Test readiness** → agent authentication/poll, actual interface open, bounded 1-second capture, PCAPNG parsing/sanitization, TShark analysis, upload এবং app-side storage validation → completion। Readiness maximum five minutes valid এবং একই agent/provider/approved destination-scope digest-এর হতে হবে। IP policy বদলালে readiness পুনরায় চালান। প্রতিটি actual capture-ও আবার interface open করে। Zero-packet readiness-এর অর্থ `INTERFACE_READY_NO_SCOPED_TRAFFIC`; traffic দেখা গেলে `SCOPED_TRAFFIC_OBSERVED`। Heartbeat/banner/interface list একা packet visibility নয়। Dashboard-এর readiness list এই attempt-এর latest 50 jobs পর্যন্ত সীমিত; অন্য attempt-এর readiness সেখানে নাও দেখা যেতে পারে।

Limits: default 30 seconds, hard maximum 60 seconds; default 1 MiB, hard maximum 2 MiB/job; one RUNNING/UPLOADING job/agent; at most four queued/running/uploading jobs and 100 retained capture requests; queue/lease timeout 120 seconds; upload read deadline 10 seconds। Completion আবার lease/status/expiry যাচাই করে; expired/failed lease resurrect করে না। Dumpcap independent duration/filesize stop conditions এবং agent file-size watcher/deadline আছে। Raw temporary snaplen সর্বোচ্চ 256 bytes; upload-এর আগে application payload ও IP/TCP option data মুছে canonical derived PCAPNG তৈরি হয়। Application আবার scope/structure validate করে sanitize করে। Raw encrypted payload বা TLS keys export করা হয় না। Original wire/payload lengths TCP sequence analysis-এর জন্য থাকে; removed payload/options-এর কারণে original header checksums আর wire-valid নয়। Checksum failure-কে network corruption হিসেবে গণনা করবেন না।

Retained file-এ backend/network addresses থাকতে পারে; তাই extra evidence permission, private storage, no-store download, SHA-256 validation ও expiry বাধ্যতামূলক। Stored file-এর comments/custom/secret/name-resolution blocks retained হয় না। Retransmissions TShark-এর heuristic observations; packet-loss percentage বা bank blame নয়। A shared encrypted connection/window-কে exact operation/payment packet হিসেবে দাবি করা হয় না; operation হলো investigation scope label। DNS/certificate/TLS handshake-এর details existing application transport evidence থেকে আসে।

Microsecond ও nanosecond timestamp resolution explicitly বোঝা হয়; derived file microseconds-এ normalize হয় (nanosecond input-এ এক microsecond-এর কম precision বাদ যায়)। Unknown clock resolution reject হয়। TLS verification disabled, `SSLKEYLOGFILE` বা Node TLS keylog option থাকলে capture enable করা যায় না।

V2 report-এর `packetCorrelation` first/last PCAP UTC timestamp-এর সঙ্গে observed transport intervals overlap হলে bounded candidate request/attempt/connection IDs দেয়। Limit সর্বোচ্চ 100 candidates/capture; truncation flag থাকে। এটি socket tuple বা packet ownership নয়। Current implementation timestamp থাকলে `TIME_WINDOW_ONLY`, না থাকলে `UNKNOWN` দেয়; `REQUEST_ATTRIBUTED`/`CONNECTION_CORRELATED` দাবি করে না। Cross-host clock skew, NAT ও shared connections যাচাই হয়নি। Request ID/operation label নিজে attribution upgrade করে না।

## Transport queue ও evidence completeness

Queue সর্বোচ্চ 128 pending+in-flight sanitized records রাখে; এক enqueue-তে সর্বোচ্চ 8। Allowlisted transient storage errors-এর জন্য সর্বোচ্চ দুই retry, 250 ms ও 1,000 ms backoff। Permanent/unknown failure retry হয় না। ব্যর্থ item বাদ গেলেও পরের item চেষ্টা হয়; একই attempt ID-এর insertion existing DB advisory-lock/duplicate guard ব্যবহার করে। Payment execution queue drain-এর জন্য অপেক্ষা করে না।

`queueHealth` current-process-only counters: accepted, persisted, duplicates, retries, recovered, dropped, permanentFailures, retryExhausted, writeErrors এবং bounded depth। Exception messages/payloads রাখা হয় না। `evidenceGap=true` মানে এই process-এ drop দেখা গেছে; কোন payment-এর evidence হারিয়েছে তার দাবি নয়। Buffer memory-only: restart, crash, serverless freeze বা অন্য instance-এর loss গণনা করা যায় না। Durable delivery দাবি নেই। V2 JSON/PDF/CSV-তে completeness, query limits, retention ও attribution limits আছে। Snapshot-এর `reconciliationCoverage` শুধু latest retained comparison; authoritative transition history নয়।

## State compatibility ও stock evidence

Matrix-এর PASS কেবল current state compatibility; bank verification নয়। Actual enums: PaymentState `INITIATED/AUTHORIZED/CAPTURED/FAILED/REFUNDED/VOIDED`; Order payment `UNPAID/PAID/REFUNDED`; OrderStatus `PENDING/CONFIRMED/PROCESSING/SHIPPED/DELIVERED/CANCELLED/RETURNED/FAILED/REFUNDED`।

| Attempt | UNPAID order | PAID order | REFUNDED order |
| --- | --- | --- | --- |
| INITIATED / AUTHORIZED | PENDING/CONFIRMED: PASS; অন্য lifecycle: WARNING | WARNING | WARNING |
| CAPTURED | FAIL | PENDING/CONFIRMED/PROCESSING/SHIPPED/DELIVERED: PASS; অন্য lifecycle: WARNING | WARNING |
| REFUNDED | FAIL | WARNING | CANCELLED/RETURNED/REFUNDED: PASS; অন্য lifecycle: WARNING |
| FAILED / VOIDED | PENDING/CONFIRMED/CANCELLED/FAILED: PASS; অন্য lifecycle: WARNING | UNKNOWN; অন্য settled attempt হতে পারে | UNKNOWN; অন্য settled attempt হতে পারে |
| Unknown enum | UNKNOWN | UNKNOWN | UNKNOWN |

Asynchronous/refund WARNING নিজে unauthorized modification প্রমাণ করে না। Verification absent হলে আলাদা `NOT_OBSERVED`; duplicate settlement count আলাদা check। Non-captured reservation check `NOT_OBSERVED`; empty stock/warehouse samples PASS নয়। AIBL original snapshot থাকলে পুরোনো variant/bundle IDs-ও query scope-এ থাকে, catalog/order variant বদলালেও original ledger comparison হয়। Original snapshot matching ledger-তে PASS হতে পারে। শুধু current-catalog match হলে UNKNOWN, mismatch হলে WARNING; historical snapshot ছাড়া original commitment সঠিক বলে দাবি নয়। Query truncation-এ relevant checks UNKNOWN/NOT_OBSERVED হয়।

Agent poll/result routes session-based customer endpoints নয়; dedicated bearer/agent ID authentication থাকে। Agent health heartbeat control plane online থাকা বোঝায়; readiness/packet visibility আলাদা। Process failure/abort-এ temporary directory cleanup হয়; crash-এর 10-minute-old agent-owned temp directories bounded janitor পরিষ্কার করে।

## Evidence export ও retention

Payment detail থেকে JSON/CSV/PDF export করুন। JSON-এ payment trace, sanitized reference hash, UTC timeline, separate HTTP/business outcome evidence, consistency checks, transport measurements, capture manifest, confidence, recommended action ও visibility limits থাকে। Customer address/phone/email, raw provider JSON, actor identity, tokens, signing state, OTP/PIN/keys export করা হয় না। CSV formula-neutralized। PDF English technical vocabulary ব্যবহার করে যাতে built-in font encoding নির্ভরযোগ্য থাকে।

JSON manifest-এর `sha256` হলো `JSON.stringify(report, null, 2)` UTF-8 bytes-এর hash। `X-Report-Payload-SHA256` একই payload scope; `X-Evidence-SHA256` actual downloaded JSON/CSV/PDF bytes-এর hash। PCAPNG download header actual canonical file-এর hash। Hash integrity comparison দেয়; স্বাধীন signature/completeness attestation নয়।

Existing `CRON_SECRET` bearer দিয়ে scheduler-এ যোগ করুন:

```text
GET /api/cron/payment-diagnostics-retention
GET /api/cron/payment-transport-retention  (existing)
```

প্রথম route এক run-এ সর্বোচ্চ 100 expired capture files/jobs ও 1,000 expired new FRONTEND events সরায়। Existing financial rows, server-side payment audit events, reconciliation records ও disputes মুছে না। Existing server event retention আলাদা operational policy-তে review করতে হবে। Expired file metadata থাকলেও download denied। Filesystem unavailable হলে evidence metadata delete করে হারানো file cleanup দাবি করে না। Scheduler configure/verify করা এই local implementation-এর বাইরে।

## Migration, rollout ও rollback

নতুন reviewed SQL:

1. `20261029120000_payment_diagnostic_capture`: independent capture queue/manifest table, bounded columns/check constraints/indexes; financial tables-এর FK/write নেই।
2. `20261029121000_order_checkout_lookup_index`: checkout JSON-key lookup-এর non-unique performance index। Existing advisory-lock idempotency policy অপরিবর্তিত; financial rows update/delete/deduplicate করা হয় না।

Existing application/`gen_eco` database-এ কোনো migration apply, `db push`, reset বা financial repair করা হয়নি। Verification-এর জন্য freshly initialized disposable PostgreSQL cluster-এ ২৫টি release migration apply হয়েছে; শেষে owned cluster বন্ধ/cleanup হয়েছে। Hardening-এ নতুন schema/migration নেই। Prisma schema validation সফল। Baseline implementation-এর Windows query-engine DLL lock-এর কারণে clean generation অসম্পূর্ণ থাকার নোট বহাল: deployment/staging-এ process-safe maintenance window-তে clean generate সফল হতে হবে। Running developer process জোর করে বন্ধ করা হয়নি।

Staging rollout:

1. Backup, active migration history/drift এবং সব pending migration review করুন। `migrate deploy` শুধু এই দুইটি নয়, সব pending release migration চালাতে পারে।
2. Production-sized staging-এ lock/statement deadlines ও index build duration পরীক্ষা করুন। Current transactional index creation বড় Order table-এ writes block করতে পারে; প্রয়োজন হলে DBA-reviewed separate concurrent-index deployment plan নিন।
3. শুধুমাত্র reviewed target-এ `npx prisma migrate status`, `npx prisma migrate deploy`, `npx prisma generate` চালান।
4. নতুন RBAC keys existing workflow-এ provision/assign করুন; staging-এ unauthorized/warehouse-only/expired-export checks করুন।
5. Capture OFF রেখে passive diagnostics enable করুন। Mock/local tests-এর পরে separately authorized EPS Sandbox/AIBL UAT, browser checkout/callback, database concurrency ও failure scenarios পরীক্ষা করুন।
6. Persistent storage ACL, retention cron, agent visibility, approved IPs ও actual TShark readiness পরীক্ষা করে limited capture enable করুন।
7. নতুন live bank endpoint বা test payment এই module স্বয়ংক্রিয়ভাবে enable করে না। Existing provider sandbox/UAT restrictions বহাল।

Rollback: নতুন server/public/capture flags OFF করুন, agent stop করুন, app পূর্বের revision-এ ফিরিয়ে দিন। Additive capture table/index রেখে দিন; settlement data rollback/reset করবেন না। Financial tables-এ downgrade SQL নেই। Evidence তার documented retention অনুযায়ী clean করুন। Failed migration হলে metadata resolve করার আগে DBA review দরকার; blind retry/reset নয়।

## Verification commands

```powershell
npm run test:payment-diagnostics
npm run test:payment-safety
npm run verify:payment-diagnostics:migrations
npm run test:payment-capture:local
npm run test:payment-diagnostics:postgres
npm run test:aibl-wallet:offline
npm run test:order-inventory
npm run test:order-idempotency
npm run test:admin-order-editor
npm run test:payment-transport
npm run test:payment-transport:local
npm run test:payment-transport:postgres
npm run validate:schema
npm run lint
npm run typecheck
npm run build:payment-diagnostics:verify
npm run verify:payment-diagnostics:artifacts
```

Machine-এর default Node পুরোনো হলে globally বদলানো ছাড়াই এই session-এর মতো `npm exec --yes --package=node@24.22.1 -- node ...` ব্যবহার করা যায়। Verification build existing network-blocking test preloader, unusable process-scoped DB URL, blank gateway credentials, diagnostics OFF এবং আলাদা `.next/payment-diagnostics-verification-build` ব্যবহার করে। এটি deployment, migration বা sandbox payment নয়।

Server deployment tracing থেকে `.env*`, protected uploads এবং packet evidence বাদ দেওয়া হয়েছে; Prisma আগে local `.env` trace করছিল। Local/VPS-এর actual files বা normal local env loading মুছে/পরিবর্তন করা হয়নি। Standalone/serverless deployments-এ required secrets runtime environment-এ এবং protected uploads/evidence persistent runtime storage-এ provision করুন। Build-এর পরে artifact privacy verifier চালানো বাধ্যতামূলক operational check; কোনো private/environment file reference থাকলে exit nonzero হবে।

দুটি explicit integration opt-in:

```powershell
# শুধুমাত্র নিজের controlled loopback fixture-এর capture; interface আগে dumpcap -D দিয়ে মিলিয়ে নিন।
$env:PAYMENT_CAPTURE_LOCAL_UAT='true'
$env:PAYMENT_CAPTURE_DUMPCAP='C:\Program Files\Wireshark\dumpcap.exe'
$env:PAYMENT_CAPTURE_TSHARK='C:\Program Files\Wireshark\tshark.exe'
$env:PAYMENT_CAPTURE_TEST_INTERFACE='<loopback interface number>'
npm run test:payment-capture:local

# সম্পূর্ণ নতুন temporary PostgreSQL cluster; existing database/DATABASE_URL ব্যবহার করে না।
$env:PAYMENT_DIAGNOSTICS_LOCAL_POSTGRES='true'
$env:PAYMENT_DIAGNOSTICS_TEST_PG_BIN='C:\Program Files\PostgreSQL\17\bin'
npm run test:payment-diagnostics:postgres
```

Opt-in ছাড়া tests `NOT_TESTED`/skip হবে। PostgreSQL test একটি free loopback port ও random test role নেয়, server data-directory মিলিয়ে নিয়ে তারপর fresh database-এ release SQL apply করে। শেষে শুধু সেই stopped, test-owned cluster cleanup করে। Existing database reset/modify হয় না। Gateway ও notification calls isolated mocks; actual inventory/settlement functions PostgreSQL transaction-এর মধ্যে চলে। Reporting daily-snapshot side effects test-এ stub করা আছে।

সর্বশেষ command counts/results ও acceptance status `payment-diagnostics-hardening-audit.bn.md`-এ; পুরোনো implementation report ঐতিহাসিক baseline। Local PostgreSQL/packet tests real bank, deployment-interface visibility, authenticated browser UAT বা formal security/compliance audit-এর বিকল্প নয়। Loopback interface number পরিবর্তিত হতে পারে: এই audit-এ 8, আগের run-এ 9 ছিল; কখনও পুরোনো সংখ্যা blindly ব্যবহার করবেন না।

## CI ও repository controls

`.github/workflows/payment-diagnostics.yml`-এ offline safety, `next typegen` + TypeScript, ESLint, schema validation, five mirrored payment migrations, controlled transport, disposable PostgreSQL এবং isolated build/artifact privacy jobs আছে। Node 24.22.1 ও immutable official action SHAs pinned; token contents-read-only, credential persistence/cache off; কোনো bank/production secret, deployment বা privileged capture job নেই। Workflow local syntax/security inspection হয়েছে; GitHub-hosted run হয়নি।

`.github/CODEOWNERS` review nomination দেয়; main protection চালু করে না। Repository rulesets GET-এ empty array; branch-protection GET-এ connector 403 `Resource not accessible by integration`। তাই existing classic protection অজানা। Owner approval নিয়ে main-এ two PR approvals, code-owner review, stale approval dismissal, conversation resolution, দুই workflow job required, strict up-to-date checks, force-push/deletion block এবং release environment reviewers সেট করুন। Secret scanning/push protection availability repository owner যাচাই করবেন; এই audit কোনো permission/rule বদলায়নি। Official guidance: [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use), [setup-node](https://github.com/actions/setup-node)।

## Primary technical references

- [Wireshark Dumpcap manual](https://www.wireshark.org/docs/man-pages/dumpcap.html): bounded capture duration/filesize, interface selection এবং PCAPNG output।
- [Wireshark TShark manual](https://www.wireshark.org/docs/man-pages/tshark.html): offline capture analysis ও fixed field export।
- [Node child_process documentation](https://nodejs.org/api/child_process.html): argument-array child processes ও process lifecycle।
- এই repository-র installed Next.js route-handler, instrumentation, server/client-component এবং distDir guides code লেখার আগে পড়া হয়েছে।
