import { transportConfiguration, transportRuntimeStatus } from "./transport-config";
import { approvedCaptureIps, requireCaptureEnabled } from "./capture-policy";

// Configuration only: never returns environment values, paths or credentials,
// and performs no network, filesystem or database I/O.
export function diagnosticReadiness(env: NodeJS.ProcessEnv = process.env,
  nodeVersion = process.versions.node, nativeUndiciVersion = process.versions.undici) {
  const transport = transportConfiguration(env, nodeVersion, nativeUndiciVersion);
  const serverEnabled = env.PAYMENT_DIAGNOSTICS_ENABLED === "true";
  const publicFlag = env.NEXT_PUBLIC_PAYMENT_DIAGNOSTICS_ENABLED === "true";
  const loggingEnabled = env.PAYMENT_CONTROL_LOGGING_ENABLED !== "false";
  let capturePolicy = "READY_CONFIGURATION_ONLY";
  try { requireCaptureEnabled(env); } catch (error) {
    const known = ["CAPTURE_DISABLED", "INSECURE_CAPTURE_TLS_CONFIGURATION", "PRIVATE_EVIDENCE_STORAGE_REQUIRED", "INVALID_DIAGNOSTIC_LIMIT"];
    capturePolicy = error instanceof Error && known.includes(error.message) ? error.message : "INVALID_CAPTURE_CONFIGURATION";
  }
  const destinations = (provider: "EPS" | "AIBL_WALLET") => {
    try { approvedCaptureIps(provider, env); return "OPERATOR_APPROVED_CONFIGURATION"; }
    catch { return "NOT_CONFIGURED_OR_INVALID"; }
  };
  return {
    browser: { serverEnabled, publicFlagConfigured: publicFlag, loggingEnabled,
      // A public variable absent at runtime does not prove the deployed browser
      // bundle was built with it disabled. The client displays its compiled flag.
      status: !serverEnabled ? "SERVER_COLLECTION_OFF" : !loggingEnabled ? "EVENT_STORAGE_OFF" : !publicFlag ? "PUBLIC_FLAG_NOT_CONFIGURED_VERIFY_BROWSER_BUNDLE" : "ENABLED_CONFIGURATION_ONLY",
      bundleVerification: "CHECK_BROWSER_BUILD_FLAG_AND_CONTROLLED_REPORT" as const,
      attribution: "SERVER_VALIDATED_REQUEST_OR_ORDER_ONLY" as const },
    transport: { ...transport, nodeVersion, nativeUndiciVersion: nativeUndiciVersion ?? null,
      runtime: transportRuntimeStatus(nodeVersion, nativeUndiciVersion),
      storageEnabled: env.PAYMENT_TRANSPORT_STORAGE_ENABLED === "true",
      instrumentedApproved: env.PAYMENT_TRANSPORT_INSTRUMENTED_APPROVED === "true",
      measurement: transport.mode === "instrumented" ? "SOCKET_OBSERVATIONS_WHEN_AVAILABLE" : transport.mode === "passive" ? "PASSIVE_EVENTS_HANDSHAKE_TIMINGS_UNAVAILABLE" : "NOT_COLLECTED" },
    capture: { policy: capturePolicy, destinations: { EPS: destinations("EPS"), AIBL_WALLET: destinations("AIBL_WALLET") },
      authenticationConfigured: /^[A-Za-z0-9_-]{1,64}$/.test(env.PAYMENT_CAPTURE_AGENT_ID ?? "") && /^[A-Za-z0-9_-]{32,256}$/.test(env.PAYMENT_CAPTURE_AGENT_TOKEN ?? ""),
      persistentStorage: env.PAYMENT_DIAGNOSTICS_EVIDENCE_DIR ? "CONFIGURED_NOT_PROBED" : "NOT_CONFIGURED",
      packetVisibility: "REQUIRES_RECENT_READINESS_WITH_SCOPED_PACKETS" as const,
      attribution: "TIME_WINDOW_ONLY" as const },
  };
}
