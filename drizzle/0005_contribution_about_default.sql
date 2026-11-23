-- A Contribution written with an empty "about" (raw SQL, an older client, a
-- default) would be about no subject, and every read filters on "about", so it
-- would be invisible. Default it to the filed subject on insert.
CREATE OR REPLACE FUNCTION "memory"."Contribution_about_default"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(NEW."about") = 0 THEN
    NEW."about" := ARRAY[NEW."subjectKey"];
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "Contribution_about_default" BEFORE INSERT ON "memory"."Contribution" FOR EACH ROW EXECUTE FUNCTION "memory"."Contribution_about_default"();
