-- SpendWise Production Database Schema
-- PostgreSQL 16

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- For fuzzy text search
CREATE EXTENSION IF NOT EXISTS "btree_gin"; -- For JSONB GIN indexes

-- ── Enums ─────────────────────────────────────────────────────────────────────

-- ── Sequences for sync (per-user monotonic counter) ────────────────────────────
CREATE SEQUENCE sync_sequence_global START 1 INCREMENT 1;

-- ── Core Tables ───────────────────────────────────────────────────────────────
-- (SQLAlchemy create_all handles this, but this init.sql adds extra optimizations)

-- Full-text search index on expenses
-- Run after tables exist:
-- CREATE INDEX idx_expenses_fts ON expenses USING GIN (to_tsvector('english', coalesce(merchant_name,'') || ' ' || coalesce(notes,'')));
-- CREATE INDEX idx_expenses_merchant_trgm ON expenses USING GIN (merchant_name gin_trgm_ops);

-- Row Level Security (if using direct DB access from mobile - not current architecture)
-- ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY expenses_user_isolation ON expenses USING (user_id = current_setting('app.current_user_id')::uuid);

-- Partial index for active (non-deleted) expenses
-- CREATE INDEX idx_expenses_active ON expenses (user_id, expense_date DESC) WHERE is_deleted = false;

-- Partial index for active budgets
-- CREATE INDEX idx_budgets_active ON budgets (user_id, period_start, period_end) WHERE is_active = true;

-- Partial index for upcoming recurring rules
-- CREATE INDEX idx_recurring_upcoming ON recurring_rules (next_due_date) WHERE is_active = true;

COMMENT ON DATABASE spendwise IS 'SpendWise expense tracker - GDPR compliant, no banking credentials stored';