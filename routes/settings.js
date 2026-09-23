const express = require("express");
const router = express.Router();
const db = require("../db/init");

// Fields that are booleans in the API/UI but stored as 0/1 integers
const BOOLEAN_FIELDS = [
  "notificationsEnabled", "emailNotifications", "orderNotifications", "qualityAlerts",
  "financeAlerts", "complaintAlerts", "supplyChainAlerts", "qrVerificationEnabled",
  "customerTraceabilityEnabled", "blockchainLedgerEnabled", "qcRequiredBeforePackaging",
  "qcRequiredBeforeDispatch", "publicTraceabilityEnabled", "showOrigin",
  "showProcessingJourney", "showQualityInfo", "showSellerInfo", "showHubInfo",
  "showDeliveryJourney", "showBlockchainVerification", "passwordRequireNumber", "twoFactorEnabled"
];

// Maps camelCase API field names to snake_case DB columns
const FIELD_MAP = {
  organizationName: "organization_name",
  appName: "app_name",
  tagline: "tagline",
  notificationsEnabled: "notifications_enabled",
  defaultLanguage: "default_language",
  timezone: "timezone",
  currency: "currency",
  emailNotifications: "email_notifications",
  orderNotifications: "order_notifications",
  qualityAlerts: "quality_alerts",
  financeAlerts: "finance_alerts",
  complaintAlerts: "complaint_alerts",
  supplyChainAlerts: "supply_chain_alerts",
  defaultBatchStatus: "default_batch_status",
  qrVerificationEnabled: "qr_verification_enabled",
  customerTraceabilityEnabled: "customer_traceability_enabled",
  blockchainLedgerEnabled: "blockchain_ledger_enabled",
  qcRequiredBeforePackaging: "qc_required_before_packaging",
  qcRequiredBeforeDispatch: "qc_required_before_dispatch",
  defaultCpCommissionPercent: "default_cp_commission_percent",
  settlementCycle: "settlement_cycle",
  minimumSettlementAmount: "minimum_settlement_amount",
  gstPercent: "gst_percent",
  platformFeePercent: "platform_fee_percent",
  deliveryFee: "delivery_fee",
  publicTraceabilityEnabled: "public_traceability_enabled",
  qrBaseUrl: "qr_base_url",
  showOrigin: "show_origin",
  showProcessingJourney: "show_processing_journey",
  showQualityInfo: "show_quality_info",
  showSellerInfo: "show_seller_info",
  showHubInfo: "show_hub_info",
  showDeliveryJourney: "show_delivery_journey",
  showBlockchainVerification: "show_blockchain_verification",
  sessionTimeoutMinutes: "session_timeout_minutes",
  passwordMinLength: "password_min_length",
  passwordRequireNumber: "password_require_number",
  twoFactorEnabled: "two_factor_enabled",
};

router.get("/", (req, res) => {
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  res.json(settings);
});

// Partial update — only fields present in the request body are changed, so
// saving one settings tab never clobbers another tab's values.
router.put("/", (req, res) => {
  const updates = [];
  const values = [];

  for (const [apiField, column] of Object.entries(FIELD_MAP)) {
    if (Object.prototype.hasOwnProperty.call(req.body, apiField)) {
      let value = req.body[apiField];
      if (BOOLEAN_FIELDS.includes(apiField)) value = value ? 1 : 0;
      updates.push(`${column} = ?`);
      values.push(value);
    }
  }

  if (updates.length > 0) {
    values.push(1);
    db.prepare(`UPDATE settings SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }

  res.json(db.prepare("SELECT * FROM settings WHERE id = 1").get());
});

module.exports = router;
