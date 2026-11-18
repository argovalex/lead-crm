-- Personal contact name: the email greeting becomes "Dear <name>," instead of "Dear <org> team,".
ALTER TABLE "gmdss_leads" ADD COLUMN "contact_name" TEXT;
