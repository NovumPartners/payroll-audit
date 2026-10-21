CREATE TYPE "public"."accrual_basis" AS ENUM('per_period', 'per_hour', 'annual_grant');--> statement-breakpoint
CREATE TYPE "public"."change_status" AS ENUM('received', 'applied_to_profile', 'verified_in_platform', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."change_type" AS ENUM('new_hire', 'termination', 'rate_change', 'housing_change', 'benefit_change', 'time_off_change', 'one_time_pay', 'deduction_change', 'schedule_change');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('onboarding', 'live', 'paused', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('active', 'terminated', 'leave');--> statement-breakpoint
CREATE TYPE "public"."exception_kind" AS ENUM('qa', 'post_submit');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('open', 'cleared', 'documented');--> statement-breakpoint
CREATE TYPE "public"."notification_audience" AS ENUM('specialist', 'lead', 'pod', 'client_contact_via_specialist');--> statement-breakpoint
CREATE TYPE "public"."pay_frequency" AS ENUM('weekly', 'biweekly', 'semimonthly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."pay_type" AS ENUM('salary', 'hourly');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('gusto', 'rippling');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('lead', 'specialist', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('scheduled', 'draft_pulled', 'qa_passed', 'qa_exceptions', 'client_approved', 'submitted', 'late');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('block', 'review', 'info');--> statement-breakpoint
CREATE TYPE "public"."expected_source" AS ENUM('profile', 'ledger', 'prior_run', 'platform_rule');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"client_id" uuid,
	"target_id" uuid,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "benefit_elections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"employee_deduction_cents" integer NOT NULL,
	"employer_contribution_cents" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_doc_box_file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "benefit_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"platform_plan_id" text NOT NULL,
	"name" text NOT NULL,
	"pre_tax" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"employee_id" uuid,
	"type" "change_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"effective_date" date NOT NULL,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"jotform_submission_id" text,
	"status" "change_status" DEFAULT 'received' NOT NULL,
	"applied_by" uuid,
	"applied_at" timestamp with time zone,
	"verified_run_id" uuid,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_company_id" text NOT NULL,
	"pay_frequency" "pay_frequency" NOT NULL,
	"cutoff_days_before_pay_date" integer DEFAULT 2 NOT NULL,
	"cutoff_hour_utc" integer DEFAULT 22 NOT NULL,
	"expected_pay_date_lag_days" integer,
	"box_folder_id" text,
	"specialist_id" uuid,
	"contact_name" text,
	"contact_email" text,
	"status" "client_status" DEFAULT 'onboarding' NOT NULL,
	"clergy_present" boolean DEFAULT false NOT NULL,
	"registered_states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"threshold_overrides" jsonb,
	"housing_earning_type_confirmed_excluded" boolean DEFAULT false NOT NULL,
	"profile_signed_by" uuid,
	"profile_signed_at" timestamp with time zone,
	"profile_pdf_box_file_id" text,
	"next_period_start" date,
	"next_period_end" date,
	"next_pay_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"platform_employee_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"hire_date" date NOT NULL,
	"termination_date" date,
	"pay_type" "pay_type" NOT NULL,
	"rate_cents" integer NOT NULL,
	"rate_effective_date" date NOT NULL,
	"standard_hours" integer DEFAULT 0 NOT NULL,
	"department" text,
	"work_state" text NOT NULL,
	"is_minister" boolean DEFAULT false NOT NULL,
	"fica_exempt" boolean DEFAULT false NOT NULL,
	"fed_withholding_voluntary" boolean DEFAULT true NOT NULL,
	"anniversary_step_increase" boolean DEFAULT false NOT NULL,
	"benefit_eligibility_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"kind" "exception_kind" DEFAULT 'qa' NOT NULL,
	"employee_id" uuid,
	"check_code" text NOT NULL,
	"severity" "severity" NOT NULL,
	"expected" text NOT NULL,
	"actual" text NOT NULL,
	"source_of_expected" "expected_source" NOT NULL,
	"description" text NOT NULL,
	"request_id" text,
	"status" "exception_status" DEFAULT 'open' NOT NULL,
	"cleared_by" uuid,
	"cleared_at" timestamp with time zone,
	"clearance_note" text,
	"recurrence_of_id" uuid,
	"prior_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "housing_allowances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"annual_amount_cents" integer NOT NULL,
	"per_period_amount_cents" integer NOT NULL,
	"resolution_date" date NOT NULL,
	"resolution_doc_box_file_id" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"run_id" uuid,
	"audience" "notification_audience" NOT NULL,
	"recipient" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"platform_payroll_id" text,
	"status" "run_status" DEFAULT 'scheduled' NOT NULL,
	"draft_snapshot" jsonb,
	"prior_snapshot" jsonb,
	"prior_run_id" uuid,
	"qa_report" jsonb,
	"qa_attempt" integer DEFAULT 0 NOT NULL,
	"qa_report_box_file_id" text,
	"qa_ran_at" timestamp with time zone,
	"preview_sent_at" timestamp with time zone,
	"client_approved_by" text,
	"client_approved_at" timestamp with time zone,
	"client_approval_method" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"submitted_snapshot" jsonb,
	"submitted_compared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_document_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"box_file_id" text NOT NULL,
	"box_file_name" text NOT NULL,
	"box_file_sha1" text,
	"kind" text NOT NULL,
	"facts" jsonb NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"employee_id" uuid,
	"field" text NOT NULL,
	"platform_value" text,
	"document_value" text,
	"source_doc_box_file_id" text,
	"question" text NOT NULL,
	"resolution" text,
	"resolved_value" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_off_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"policy_name" text NOT NULL,
	"accrual_rate_hours_x100" integer NOT NULL,
	"accrual_basis" "accrual_basis" NOT NULL,
	"cap_hours" integer,
	"carryover_rule" text,
	"eligible_after_days" integer DEFAULT 0 NOT NULL,
	"assigned_employee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"entra_oid" text,
	"slack_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_entra_oid_unique" UNIQUE("entra_oid")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_elections" ADD CONSTRAINT "benefit_elections_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_elections" ADD CONSTRAINT "benefit_elections_plan_id_benefit_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."benefit_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_plans" ADD CONSTRAINT "benefit_plans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_specialist_id_users_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_profile_signed_by_users_id_fk" FOREIGN KEY ("profile_signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employees" ADD CONSTRAINT "employees_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "housing_allowances" ADD CONSTRAINT "housing_allowances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profile_document_facts" ADD CONSTRAINT "profile_document_facts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_events" ADD CONSTRAINT "run_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_off_policies" ADD CONSTRAINT "time_off_policies_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_client_at" ON "audit_log" USING btree ("client_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "elections_employee" ON "benefit_elections" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "benefit_plans_client_platform" ON "benefit_plans" USING btree ("client_id","platform_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_requests_jotform" ON "change_requests" USING btree ("jotform_submission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_requests_client_effective" ON "change_requests" USING btree ("client_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_platform_company" ON "clients" USING btree ("platform","platform_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employees_client_platform" ON "employees" USING btree ("client_id","platform_employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exceptions_run_status" ON "exceptions" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exceptions_run_attempt" ON "exceptions" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "housing_employee" ON "housing_allowances" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_client" ON "notifications" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_client_period" ON "payroll_runs" USING btree ("client_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_cutoff" ON "payroll_runs" USING btree ("cutoff_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profile_document_facts_file" ON "profile_document_facts" USING btree ("client_id","box_file_id","box_file_sha1");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_questions_client" ON "profile_questions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_events_run" ON "run_events" USING btree ("run_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "time_off_policies_client_name" ON "time_off_policies" USING btree ("client_id","policy_name");