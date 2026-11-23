ALTER TABLE "memory"."Contribution" ADD COLUMN "about" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "memory"."Contribution" SET "about" = ARRAY["subjectKey"];--> statement-breakpoint
CREATE INDEX "Contribution_about_idx" ON "memory"."Contribution" USING gin ("about");
