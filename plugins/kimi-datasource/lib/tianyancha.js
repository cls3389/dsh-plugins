"use strict";

const path = require("node:path");

const TIANYANCHA_DATA_SOURCE = "tianyancha";
const TIANYANCHA_APIS = {
  companySearch: "tianyancha_company_search",
  apiSearch: "tianyancha_api_search",
  apiCall: "tianyancha_api_call",
};
const COMPANY_PROFILE_API = "工商信息-企业基本信息";

function buildTianyanchaFilePath(filesDir, apiName) {
  const safeApiName = String(apiName).replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(filesDir, `tianyancha_${safeApiName}_${Date.now()}.csv`);
}

module.exports = {
  TIANYANCHA_DATA_SOURCE,
  TIANYANCHA_APIS,
  COMPANY_PROFILE_API,
  buildTianyanchaFilePath,
};
