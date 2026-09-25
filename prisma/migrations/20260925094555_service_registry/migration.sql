-- CreateTable
CREATE TABLE "descriptor_sets" (
    "id" UUID NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "descriptor_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'connect',
    "descriptor_set_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "services_descriptor_set_id_idx" ON "services"("descriptor_set_id");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_descriptor_set_id_fkey" FOREIGN KEY ("descriptor_set_id") REFERENCES "descriptor_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
