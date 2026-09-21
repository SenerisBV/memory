CREATE SCHEMA "memory";
--> statement-breakpoint
CREATE TABLE "memory"."Alias" (
	"id" text PRIMARY KEY NOT NULL,
	"authorAgent" text NOT NULL,
	"localKey" text NOT NULL,
	"subjectKey" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory"."Contribution" (
	"id" text PRIMARY KEY NOT NULL,
	"authorAgent" text NOT NULL,
	"subjectKey" text NOT NULL,
	"principalId" text,
	"content" text NOT NULL,
	"why" text NOT NULL,
	"source" text DEFAULT 'contribution' NOT NULL,
	"ts" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory"."Observation" (
	"id" text PRIMARY KEY NOT NULL,
	"authorAgent" text NOT NULL,
	"subjectKey" text NOT NULL,
	"about" text[] NOT NULL,
	"predicate" text NOT NULL,
	"value" text NOT NULL,
	"valueNum" double precision,
	"unit" text,
	"ts" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"source" text NOT NULL,
	"sourceGrade" text DEFAULT 'F6' NOT NULL,
	"naturalKey" text,
	"provenancePath" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"visibility" text DEFAULT 'fleet' NOT NULL,
	"supersededAt" timestamp (3),
	"supersededById" text,
	"kind" text DEFAULT 'general' NOT NULL,
	"topics" text[] DEFAULT ARRAY['general'::text] NOT NULL,
	CONSTRAINT "Observation_about_primary_check" CHECK (cardinality("memory"."Observation"."about") >= 1 AND "memory"."Observation"."about"[1] = "memory"."Observation"."subjectKey")
);
--> statement-breakpoint
CREATE TABLE "memory"."Subject" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"attention" text DEFAULT 'track' NOT NULL,
	"members" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"profileDirty" boolean DEFAULT false NOT NULL,
	"profilePath" text,
	"profileSynthAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "Subject_key_typed_check" CHECK ("memory"."Subject"."key" ~ '^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "Alias_authorAgent_localKey_key" ON "memory"."Alias" USING btree ("authorAgent","localKey");--> statement-breakpoint
CREATE INDEX "Alias_subjectKey_idx" ON "memory"."Alias" USING btree ("subjectKey");--> statement-breakpoint
CREATE INDEX "Contribution_subjectKey_ts_idx" ON "memory"."Contribution" USING btree ("subjectKey","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "Observation_authorAgent_subjectKey_naturalKey_key" ON "memory"."Observation" USING btree ("authorAgent","subjectKey","naturalKey");--> statement-breakpoint
CREATE INDEX "Observation_subjectKey_ts_idx" ON "memory"."Observation" USING btree ("subjectKey","ts");--> statement-breakpoint
CREATE INDEX "Observation_about_idx" ON "memory"."Observation" USING gin ("about");--> statement-breakpoint
CREATE INDEX "Observation_topics_idx" ON "memory"."Observation" USING gin ("topics");--> statement-breakpoint
CREATE UNIQUE INDEX "Observation_supersededById_key" ON "memory"."Observation" USING btree ("supersededById");--> statement-breakpoint
CREATE UNIQUE INDEX "Subject_key_key" ON "memory"."Subject" USING btree ("key");--> statement-breakpoint
CREATE INDEX "Subject_attention_idx" ON "memory"."Subject" USING btree ("attention");