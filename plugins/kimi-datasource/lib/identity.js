"use strict";

const os = require("node:os");
const platform = require("node:process").platform;
const { randomUUID } = require("node:crypto");

const KIMI_DATASOURCE_VERSION = "3.0.0";
const KIMI_OAUTH_PLATFORM = "kimi_code_cli";
const KIMI_DATASOURCE_PLATFORM = "kimi-code-cli";

function asciiHeader(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .split("")
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
    .join("")
    .trim();
  return cleaned || fallback;
}

function deviceName() {
  return asciiHeader(os.hostname());
}

function newDeviceId() {
  return randomUUID();
}

function deviceModel() {
  const system = platform || "unknown";
  const release = os.release();
  const machine = os.machine();
  if (system === "darwin") return asciiHeader(`macOS ${release} ${machine}`);
  if (system === "win32") return asciiHeader(`Windows ${release} ${machine}`);
  return asciiHeader(`${system} ${release} ${machine}`);
}

function deviceOsVersion() {
  return asciiHeader(os.release(), "unknown");
}

function oauthDeviceHeaders(deviceId, version = KIMI_DATASOURCE_VERSION) {
  return {
    "X-Msh-Platform": KIMI_OAUTH_PLATFORM,
    "X-Msh-Version": asciiHeader(version),
    "X-Msh-Device-Name": deviceName(),
    "X-Msh-Device-Model": deviceModel(),
    "X-Msh-Os-Version": deviceOsVersion(),
    "X-Msh-Device-Id": asciiHeader(deviceId),
  };
}

function datasourceHeaders(token, deviceId, version = KIMI_DATASOURCE_VERSION) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Msh-Tool-Call-Id": randomUUID(),
    "X-Msh-Platform": asciiHeader(process.env.KIMI_MSH_PLATFORM || KIMI_DATASOURCE_PLATFORM),
    "X-Msh-Version": asciiHeader(process.env.KIMI_MSH_VERSION || version),
    "X-Msh-Device-Name": deviceName(),
    "X-Msh-Device-Model": deviceModel(),
    "X-Msh-Os-Version": deviceOsVersion(),
    "X-Msh-Device-Id": asciiHeader(process.env.KIMI_MSH_DEVICE_ID || deviceId),
    "User-Agent": `kimi-datasource/${version}`,
  };
}

module.exports = {
  KIMI_DATASOURCE_VERSION,
  KIMI_OAUTH_PLATFORM,
  KIMI_DATASOURCE_PLATFORM,
  deviceName,
  newDeviceId,
  deviceModel,
  deviceOsVersion,
  oauthDeviceHeaders,
  datasourceHeaders,
};
