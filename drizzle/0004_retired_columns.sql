ALTER TABLE "memory"."Contribution" ADD COLUMN "retiredAt" timestamp (3);--> statement-breakpoint
ALTER TABLE "memory"."Contribution" ADD COLUMN "retiredByKind" text;--> statement-breakpoint
ALTER TABLE "memory"."Contribution" ADD COLUMN "retiredById" text;--> statement-breakpoint
ALTER TABLE "memory"."Contribution" ADD COLUMN "retiredReason" text;--> statement-breakpoint
ALTER TABLE "memory"."Observation" ADD COLUMN "retiredAt" timestamp (3);--> statement-breakpoint
ALTER TABLE "memory"."Observation" ADD COLUMN "retiredByKind" text;--> statement-breakpoint
ALTER TABLE "memory"."Observation" ADD COLUMN "retiredById" text;--> statement-breakpoint
ALTER TABLE "memory"."Observation" ADD COLUMN "retiredReason" text;