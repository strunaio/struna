-- AlterTable
ALTER TABLE "process_instances" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancel_requested_at" TIMESTAMPTZ(3);
