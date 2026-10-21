/**
 * Drizzle schema for the Payroll QA system (Postgres).
 * Mirrors section 03 of the build specification. No SSN, bank, or DOB columns anywhere.
 */
import { boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const platformEnum = pgEnum("platform", ["gusto", "rippling"]);
export const clientStatusEnum = pgEnum("client_status", ["onboarding", "live", "paused", "offboarded"]);
export const payFrequencyEnum = pgEnum("pay_frequency", ["weekly", "biweekly", "semimonthly", "monthly"]);
export const employeeStatusEnum = pgEnum("employee_status", ["active", "terminated", "leave"]);
export const payTypeEnum = pgEnum("pay_type", ["salary", "hourly"]);
export const accrualBasisEnum = pgEnum("accrual_basis", ["per_period", "per_hour", "annual_grant"]);
export const changeTypeEnum = pgEnum("change_type", [
  "new_hire", "termination", "rate_change", "housing_change", "benefit_change",
  "time_off_change", "one_time_pay", "deduction_change", "schedule_change",
]);
export const changeStatusEnum = pgEnum("change_status", ["received", "applied_to_profile", "verified_in_platform", "rejected"]);
export const runStatusEnum = pgEnum("run_status", [
  "scheduled", "draft_pulled", "qa_passed", "qa_exceptions", "client_approved", "submitted", "late",
]);
export const severityEnum = pgEnum("severity", ["block", "review", "info"]);
export const exceptionStatusEnum = pgEnum("exception_status", ["open", "cleared", "documented"]);
export const sourceEnum = pgEnum("expected_source", ["profile", "ledger", "prior_run", "platform_rule"]);
export const roleEnum = pgEnum("user_role", ["lead", "specialist", "reviewer"]);

const audit = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  active: boolean("active").notNull().default(true),
  ...audit,
});

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  legalName: text("legal_name").notNull(),
  platform: platformEnum("platform").notNull(),
  platformCompanyId: text("platform_company_id").notNull(),
  payFrequency: payFrequencyEnum("pay_frequency").notNull(),
  cutoffDaysBeforePayDate: integer("cutoff_days_before_pay_date").notNull().default(2),
  boxFolderId: text("box_folder_id"),
  specialistId: uuid("specialist_id").references(() => users.id),
  status: clientStatusEnum("status").notNull().default("onboarding"),
  clergyPresent: boolean("clergy_present").notNull().default(false),
  registeredStates: jsonb("registered_states").$type<string[]>().notNull().default([]),
  thresholdOverrides: jsonb("threshold_overrides").$type<Record<string, number>>(),
  profileSignedBy: uuid("profile_signed_by").references(() => users.id),
  profileSignedAt: timestamp("profile_signed_at", { withTimezone: true }),
  profilePdfBoxFileId: text("profile_pdf_box_file_id"),
  ...audit,
}, (t) => [uniqueIndex("clients_platform_company").on(t.platform, t.platformCompanyId)]);

export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  platformEmployeeId: text("platform_employee_id").notNull(),
  name: text("name").notNull(),
  status: employeeStatusEnum("status").notNull().default("active"),
  hireDate: date("hire_date").notNull(),
  terminationDate: date("termination_date"),
  payType: payTypeEnum("pay_type").notNull(),
  rateCents: integer("rate_cents").notNull(),
  rateEffectiveDate: date("rate_effective_date").notNull(),
  standardHours: integer("standard_hours").notNull().default(0),
  department: text("department"),
  workState: text("work_state").notNull(),
  isMinister: boolean("is_minister").notNull().default(false),
  ficaExempt: boolean("fica_exempt").notNull().default(false),
  fedWithholdingVoluntary: boolean("fed_withholding_voluntary").notNull().default(true),
  anniversaryStepIncrease: boolean("anniversary_step_increase").notNull().default(false),
  benefitEligibilityDate: date("benefit_eligibility_date"),
  ...audit,
}, (t) => [uniqueIndex("employees_client_platform").on(t.clientId, t.platformEmployeeId)]);

export const housingAllowances = pgTable("housing_allowances", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  annualAmountCents: integer("annual_amount_cents").notNull(),
  perPeriodAmountCents: integer("per_period_amount_cents").notNull(),
  resolutionDate: date("resolution_date").notNull(),
  resolutionDocBoxFileId: text("resolution_doc_box_file_id"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  ...audit,
}, (t) => [index("housing_employee").on(t.employeeId)]);

export const benefitPlans = pgTable("benefit_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  platformPlanId: text("platform_plan_id").notNull(),
  name: text("name").notNull(),
  preTax: boolean("pre_tax").notNull().default(true),
  ...audit,
}, (t) => [uniqueIndex("benefit_plans_client_platform").on(t.clientId, t.platformPlanId)]);

export const benefitElections = pgTable("benefit_elections", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  planId: uuid("plan_id").notNull().references(() => benefitPlans.id),
  employeeDeductionCents: integer("employee_deduction_cents").notNull(),
  employerContributionCents: integer("employer_contribution_cents").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  sourceDocBoxFileId: text("source_doc_box_file_id"),
  ...audit,
}, (t) => [index("elections_employee").on(t.employeeId)]);

export const timeOffPolicies = pgTable("time_off_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  policyName: text("policy_name").notNull(),
  accrualRateHours: integer("accrual_rate_hours_x100").notNull(), // hours * 100 to keep integers
  accrualBasis: accrualBasisEnum("accrual_basis").notNull(),
  capHours: integer("cap_hours"),
  carryoverRule: text("carryover_rule"),
  eligibleAfterDays: integer("eligible_after_days").notNull().default(0),
  assignedEmployeeIds: jsonb("assigned_employee_ids").$type<string[]>().notNull().default([]),
  ...audit,
});

export const changeRequests = pgTable("change_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  employeeId: uuid("employee_id").references(() => employees.id),
  type: changeTypeEnum("type").notNull(),
  payload: jsonb("payload").notNull(),
  effectiveDate: date("effective_date").notNull(),
  submittedBy: text("submitted_by").notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
  jotformSubmissionId: text("jotform_submission_id"),
  status: changeStatusEnum("status").notNull().default("received"),
  appliedBy: uuid("applied_by").references(() => users.id),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  verifiedRunId: uuid("verified_run_id"),
  rejectionReason: text("rejection_reason"),
  ...audit,
}, (t) => [
  uniqueIndex("change_requests_jotform").on(t.jotformSubmissionId),
  index("change_requests_client_effective").on(t.clientId, t.effectiveDate),
]);

export const payrollRuns = pgTable("payroll_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payDate: date("pay_date").notNull(),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
  platformPayrollId: text("platform_payroll_id"),
  status: runStatusEnum("status").notNull().default("scheduled"),
  draftSnapshot: jsonb("draft_snapshot"), // normalized DraftRun as pulled
  priorRunId: uuid("prior_run_id"),
  qaReport: jsonb("qa_report"), // RunReport
  qaReportBoxFileId: text("qa_report_box_file_id"),
  qaRanAt: timestamp("qa_ran_at", { withTimezone: true }),
  clientApprovedBy: text("client_approved_by"),
  clientApprovedAt: timestamp("client_approved_at", { withTimezone: true }),
  previewToken: text("preview_token"),
  previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true }),
  submittedBy: uuid("submitted_by").references(() => users.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  submittedSnapshot: jsonb("submitted_snapshot"),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
  ...audit,
}, (t) => [
  uniqueIndex("runs_client_period").on(t.clientId, t.periodStart, t.periodEnd),
  index("runs_cutoff").on(t.cutoffAt),
]);

export const exceptions = pgTable("exceptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => payrollRuns.id),
  employeeId: uuid("employee_id").references(() => employees.id),
  checkCode: text("check_code").notNull(),
  severity: severityEnum("severity").notNull(),
  expected: text("expected").notNull(),
  actual: text("actual").notNull(),
  sourceOfExpected: sourceEnum("source_of_expected").notNull(),
  description: text("description").notNull(),
  status: exceptionStatusEnum("status").notNull().default("open"),
  clearedBy: uuid("cleared_by").references(() => users.id),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  clearanceNote: text("clearance_note"),
  recurrenceOfId: uuid("recurrence_of_id"),
  ...audit,
}, (t) => [index("exceptions_run_status").on(t.runId, t.status)]);

export const profileQuestions = pgTable("profile_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  employeeId: uuid("employee_id").references(() => employees.id),
  field: text("field").notNull(),
  platformValue: text("platform_value"),
  documentValue: text("document_value"),
  sourceDocBoxFileId: text("source_doc_box_file_id"),
  question: text("question").notNull(),
  resolution: text("resolution"), // "platform" | "document" | "corrected"
  resolvedValue: text("resolved_value"),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  ...audit,
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id").references(() => users.id),
  action: text("action").notNull(), // "exception.cleared" | "profile.signed" | "run.viewed" | ...
  clientId: uuid("client_id").references(() => clients.id),
  targetId: uuid("target_id"),
  detail: jsonb("detail"),
}, (t) => [index("audit_client_at").on(t.clientId, t.at)]);
