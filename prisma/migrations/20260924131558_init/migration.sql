-- CreateTable
CREATE TABLE "process_definitions" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "process_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_instances" (
    "id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "variables" JSONB NOT NULL DEFAULT '{}',
    "state" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "runnable_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "process_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_signals" (
    "id" BIGSERIAL NOT NULL,
    "instance_id" UUID NOT NULL,
    "element_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_events" (
    "id" BIGSERIAL NOT NULL,
    "instance_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "element_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "process_definitions_name_version_key" ON "process_definitions"("name", "version");

-- CreateIndex
CREATE INDEX "process_instances_definition_id_idx" ON "process_instances"("definition_id");

-- CreateIndex
CREATE INDEX "process_instances_status_idx" ON "process_instances"("status");

-- CreateIndex
CREATE INDEX "process_instances_runnable_at_idx" ON "process_instances"("runnable_at");

-- CreateIndex
CREATE INDEX "process_signals_instance_id_id_idx" ON "process_signals"("instance_id", "id");

-- CreateIndex
CREATE INDEX "process_events_instance_id_id_idx" ON "process_events"("instance_id", "id");

-- AddForeignKey
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "process_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_signals" ADD CONSTRAINT "process_signals_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "process_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_events" ADD CONSTRAINT "process_events_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "process_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
