CREATE TYPE "public"."account_status" AS ENUM('HEALTHY', 'DEGRADED', 'DISCONNECTED', 'DRAINING');--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('file', 'folder');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"file_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"remote_id" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"nonce" text,
	CONSTRAINT "file_chunks_file_id_index_pk" PRIMARY KEY("file_id","index")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"parent_id" uuid,
	"type" "node_type" NOT NULL,
	"name" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime" text,
	"encrypted" boolean DEFAULT false NOT NULL,
	"encrypt_by_default" boolean DEFAULT false NOT NULL,
	"key_id" text,
	"wrapped_dek" text,
	"trashed_at" timestamp with time zone,
	"trash_root_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"upload_id" uuid,
	"bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_cleanup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"remote_id" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"download_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "storage_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"status" "account_status" DEFAULT 'HEALTHY' NOT NULL,
	"app_folder_id" text,
	"quota_limit" bigint DEFAULT 0 NOT NULL,
	"quota_usage" bigint DEFAULT 0 NOT NULL,
	"quota_synced_at" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"plan" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"totp_secret_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_account_id_storage_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."storage_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_id_nodes_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_account_id_storage_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."storage_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_account_id_storage_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."storage_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_cleanup" ADD CONSTRAINT "remote_cleanup_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_cleanup" ADD CONSTRAINT "remote_cleanup_account_id_storage_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."storage_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_accounts" ADD CONSTRAINT "storage_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_owner_open_idx" ON "alerts" USING btree ("owner_id","resolved_at");--> statement-breakpoint
CREATE INDEX "file_chunks_account_idx" ON "file_chunks" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_live_name_uq" ON "nodes" USING btree ("owner_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"name") WHERE "nodes"."trashed_at" is null;--> statement-breakpoint
CREATE INDEX "nodes_parent_idx" ON "nodes" USING btree ("owner_id","parent_id");--> statement-breakpoint
CREATE INDEX "nodes_trash_idx" ON "nodes" USING btree ("owner_id","trashed_at");--> statement-breakpoint
CREATE INDEX "nodes_search_idx" ON "nodes" USING btree ("owner_id",lower("name") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "quota_res_account_idx" ON "quota_reservations" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE INDEX "remote_cleanup_due_idx" ON "remote_cleanup" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "sessions_owner_idx" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "share_links_node_idx" ON "share_links" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_accounts_owner_sub_uq" ON "storage_accounts" USING btree ("owner_id","google_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_idem_uq" ON "uploads" USING btree ("owner_id","idempotency_key");