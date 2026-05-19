-- ============================================================
-- BoothMarket Database Schema
-- Migration: 001_initial_schema.sql
-- Run: psql $DATABASE_URL -f 001_initial_schema.sql
-- ============================================================

-- Enable UUID generation extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- ENUM TYPES
-- ─────────────────────────────────────────────

-- User roles across the platform
CREATE TYPE user_role AS ENUM ('consultant', 'rental_provider', 'company', 'admin');

-- Account approval lifecycle
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'suspended');

-- Inquiry lifecycle between consultant and rental provider
CREATE TYPE inquiry_status AS ENUM ('pending', 'responded', 'accepted', 'declined', 'cancelled');

-- Product availability state
CREATE TYPE product_status AS ENUM ('active', 'inactive', 'out_of_stock');

-- ─────────────────────────────────────────────
-- TABLE: users
-- Central identity table. All 3 player types + admin live here.
-- ─────────────────────────────────────────────
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               VARCHAR(255) NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,                       -- bcrypt hashed, never plain text
    role                user_role NOT NULL,
    approval_status     approval_status NOT NULL DEFAULT 'pending',
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100) NOT NULL,
    phone               VARCHAR(20),
    company_name        VARCHAR(255),                        -- Firm/brand name
    city                VARCHAR(100),
    state               VARCHAR(100),
    pincode             VARCHAR(10),
    profile_image_url   TEXT,
    is_email_verified   BOOLEAN DEFAULT FALSE,
    email_verify_token  TEXT,                                -- One-time token for email verification
    reset_token         TEXT,                                -- Password reset token
    reset_token_expiry  TIMESTAMPTZ,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on email for fast login lookups
CREATE INDEX idx_users_email ON users(email);
-- Index on role + status for admin dashboard queries
CREATE INDEX idx_users_role_status ON users(role, approval_status);

-- ─────────────────────────────────────────────
-- TABLE: consultant_profiles
-- Extended profile for exhibition booth designers (consultants)
-- ─────────────────────────────────────────────
CREATE TABLE consultant_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bio                 TEXT,
    years_experience    INTEGER,
    specializations     TEXT[],                              -- e.g. ['LED walls', 'Custom booths', 'Modular']
    portfolio_urls      TEXT[],                              -- Links to past work
    production_house_name VARCHAR(255),
    service_cities      TEXT[],                              -- Cities they operate in
    avg_project_size    NUMERIC(12,2),                       -- Avg budget they handle
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

-- ─────────────────────────────────────────────
-- TABLE: rental_provider_profiles
-- Extended profile for individuals who rent out items
-- ─────────────────────────────────────────────
CREATE TABLE rental_provider_profiles (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bio                     TEXT,
    warehouse_address       TEXT,
    delivery_radius_km      INTEGER DEFAULT 50,              -- Max km they deliver
    accepts_self_pickup     BOOLEAN DEFAULT TRUE,
    bank_account_name       VARCHAR(255),                    -- For future payment payout
    bank_account_number     VARCHAR(50),
    bank_ifsc_code          VARCHAR(20),
    gstin                   VARCHAR(20),                     -- GST number for invoicing
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

-- ─────────────────────────────────────────────
-- TABLE: company_profiles
-- Extended profile for end-customer companies
-- ─────────────────────────────────────────────
CREATE TABLE company_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    industry            VARCHAR(100),                        -- e.g. 'Automotive', 'Tech', 'FMCG'
    num_events_per_year INTEGER,
    typical_budget      NUMERIC(12,2),
    website_url         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

-- ─────────────────────────────────────────────
-- TABLE: product_categories
-- Pre-seeded categories: Furniture, LED, Lighting, Wallpaper, etc.
-- ─────────────────────────────────────────────
CREATE TABLE product_categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    slug        VARCHAR(100) NOT NULL UNIQUE,               -- URL-friendly name
    icon_url    TEXT,
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial marketing domain categories
INSERT INTO product_categories (name, slug) VALUES
    ('Furniture', 'furniture'),
    ('LED Displays', 'led-displays'),
    ('Lighting', 'lighting'),
    ('Wallpaper & Graphics', 'wallpaper-graphics'),
    ('Flooring', 'flooring'),
    ('Modular Structures', 'modular-structures'),
    ('AV Equipment', 'av-equipment'),
    ('Counters & Kiosks', 'counters-kiosks');

-- ─────────────────────────────────────────────
-- TABLE: products
-- Rental items listed by rental providers
-- ─────────────────────────────────────────────
CREATE TABLE products (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id             INTEGER NOT NULL REFERENCES product_categories(id),
    title                   VARCHAR(255) NOT NULL,
    description             TEXT NOT NULL,
    status                  product_status NOT NULL DEFAULT 'active',

    -- Pricing
    price_per_day           NUMERIC(10,2) NOT NULL,          -- Base rental per day (INR)
    security_deposit        NUMERIC(10,2) DEFAULT 0,         -- Refundable deposit
    minimum_rental_days     INTEGER NOT NULL DEFAULT 1,

    -- Logistics
    delivery_time_days      INTEGER NOT NULL DEFAULT 1,      -- Days needed before event
    delivery_radius_km      INTEGER,                         -- Override provider default
    delivery_charge         NUMERIC(10,2) DEFAULT 0,

    -- Physical specs
    length_cm               NUMERIC(8,2),
    width_cm                NUMERIC(8,2),
    height_cm               NUMERIC(8,2),
    weight_kg               NUMERIC(8,2),

    -- Inventory
    stock_quantity          INTEGER NOT NULL DEFAULT 1,

    -- SEO & search
    tags                    TEXT[],                          -- Searchable keywords
    city                    VARCHAR(100),
    state                   VARCHAR(100),

    view_count              INTEGER DEFAULT 0,               -- Analytics
    inquiry_count           INTEGER DEFAULT 0,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast marketplace search queries
CREATE INDEX idx_products_provider ON products(provider_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_city ON products(city);
CREATE INDEX idx_products_price ON products(price_per_day);
-- Full-text search index on title + description
CREATE INDEX idx_products_fts ON products USING GIN(to_tsvector('english', title || ' ' || description));

-- ─────────────────────────────────────────────
-- TABLE: product_images
-- Multiple images per product, ordered by display order
-- ─────────────────────────────────────────────
CREATE TABLE product_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_url       TEXT NOT NULL,                           -- GCS public URL
    gcs_object_name TEXT NOT NULL,                           -- GCS object path (for deletion)
    display_order   INTEGER NOT NULL DEFAULT 0,              -- 0 = primary/cover image
    alt_text        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_images_product ON product_images(product_id);

-- ─────────────────────────────────────────────
-- TABLE: product_availability
-- Blocked-out dates when the product is not available
-- ─────────────────────────────────────────────
CREATE TABLE product_availability (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    blocked_date    DATE NOT NULL,                           -- One row per blocked day
    reason          VARCHAR(100) DEFAULT 'booked',           -- 'booked', 'maintenance', 'manual'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(product_id, blocked_date)
);

CREATE INDEX idx_availability_product_date ON product_availability(product_id, blocked_date);

-- ─────────────────────────────────────────────
-- TABLE: inquiries
-- Consultant → Rental Provider inquiry for a product
-- No payment at this stage — pure lead/request system
-- ─────────────────────────────────────────────
CREATE TABLE inquiries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id          UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    consultant_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status              inquiry_status NOT NULL DEFAULT 'pending',

    -- Event details the consultant provides
    event_name          VARCHAR(255),
    event_city          VARCHAR(100),
    rental_start_date   DATE NOT NULL,
    rental_end_date     DATE NOT NULL,
    quantity_needed     INTEGER NOT NULL DEFAULT 1,

    -- Communication thread
    consultant_message  TEXT NOT NULL,
    provider_response   TEXT,
    responded_at        TIMESTAMPTZ,

    -- Calculated fields (denormalized for speed)
    rental_days         INTEGER GENERATED ALWAYS AS
                            (rental_end_date - rental_start_date + 1) STORED,
    estimated_total     NUMERIC(12,2),                       -- Filled on submit

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inquiries_consultant ON inquiries(consultant_id);
CREATE INDEX idx_inquiries_provider ON inquiries(provider_id);
CREATE INDEX idx_inquiries_product ON inquiries(product_id);
CREATE INDEX idx_inquiries_status ON inquiries(status);

-- ─────────────────────────────────────────────
-- TABLE: admin_actions
-- Audit trail for every admin approve/reject action
-- ─────────────────────────────────────────────
CREATE TABLE admin_actions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id        UUID NOT NULL REFERENCES users(id),
    target_user_id  UUID NOT NULL REFERENCES users(id),
    action          VARCHAR(50) NOT NULL,                    -- 'approved', 'rejected', 'suspended'
    reason          TEXT,                                    -- Rejection reason shown to user
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_actions_target ON admin_actions(target_user_id);

-- ─────────────────────────────────────────────
-- TABLE: refresh_tokens
-- Secure JWT refresh token store (allows logout + revocation)
-- ─────────────────────────────────────────────
CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,                        -- Hashed refresh token
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ─────────────────────────────────────────────
-- FUNCTION: auto-update updated_at timestamp
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply the trigger to all tables with updated_at
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_consultant_profiles_updated_at
    BEFORE UPDATE ON consultant_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_rental_profiles_updated_at
    BEFORE UPDATE ON rental_provider_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_inquiries_updated_at
    BEFORE UPDATE ON inquiries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────
-- SEED: Default Admin User
-- Change password immediately after first login!
-- ─────────────────────────────────────────────
INSERT INTO users (
    email, password_hash, role, approval_status,
    first_name, last_name, is_email_verified
) VALUES (
    'admin@boothmarket.com',
    '$2b$12$placeholder_change_this_immediately',  -- Reset via admin panel
    'admin',
    'approved',
    'Platform',
    'Admin',
    TRUE
);
