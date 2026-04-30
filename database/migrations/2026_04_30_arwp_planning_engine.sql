USE barabara_system;

-- ============================================================
-- Do not run this SQL in Workbench unless recovering - it is dbase backup to recreate it as IS
-- ARWP Planning Engine Migration
-- Purpose:
-- - Add Annual Roads Workplan planning support
-- - Add KRB/Engineer estimate rates
-- - Add successful bidder/contract rates
-- - Link ARWP lots to projects
-- - Support ignored/omitted planned roads
-- - Support non-road items such as preliminaries/site buildings
--
-- NOTE:
-- This migration is for recreating the schema on another database.
-- Do not re-run blindly on the current database because these changes
-- have already been applied manually during development.
-- ============================================================


-- ============================================================
-- 1. Extend activities table
-- Original table had: id, code, name
-- ============================================================

ALTER TABLE activities
ADD COLUMN unit VARCHAR(50) NULL AFTER name;

ALTER TABLE activities
ADD COLUMN work_category VARCHAR(255) NULL AFTER unit;

ALTER TABLE activities
ADD COLUMN work_description TEXT NULL AFTER work_category;

ALTER TABLE activities
ADD UNIQUE KEY unique_activity_code (code);


-- ============================================================
-- 2. Extend roads table
-- ============================================================

ALTER TABLE roads
ADD COLUMN surface_type VARCHAR(100) NULL AFTER road_name,
ADD COLUMN condition_status VARCHAR(100) NULL AFTER surface_type;


-- ============================================================
-- 3. Annual Workplan Header
-- ============================================================

CREATE TABLE IF NOT EXISTS annual_workplans (
    id INT AUTO_INCREMENT PRIMARY KEY,

    financial_year VARCHAR(20) NOT NULL,
    region VARCHAR(100) NOT NULL DEFAULT 'Coast',

    title VARCHAR(255) NULL,

    status ENUM('draft', 'submitted', 'approved', 'archived') NOT NULL DEFAULT 'draft',

    base_workplan_id INT NULL,

    created_by INT NULL,
    approved_by INT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    approved_at TIMESTAMP NULL,

    UNIQUE KEY unique_workplan_year_region (financial_year, region),

    CONSTRAINT fk_workplan_base
        FOREIGN KEY (base_workplan_id)
        REFERENCES annual_workplans(id)
        ON DELETE SET NULL
);


-- ============================================================
-- 4. KRB / Engineer Estimate Activity Rates
-- These are pre-tender estimate rates.
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_rates (
    id INT AUTO_INCREMENT PRIMARY KEY,

    activity_id INT NOT NULL,
    financial_year VARCHAR(20) NOT NULL,
    region VARCHAR(100) NOT NULL DEFAULT 'National',

    unit_rate DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    direct_cost DECIMAL(15,2) NULL,

    source VARCHAR(100) NULL DEFAULT 'KRB',
    notes TEXT NULL,

    is_active TINYINT(1) NOT NULL DEFAULT 1,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_activity_rate_year_region (
        activity_id,
        financial_year,
        region
    ),

    CONSTRAINT fk_activity_rates_activity
        FOREIGN KEY (activity_id)
        REFERENCES activities(id)
        ON DELETE CASCADE
);


-- ============================================================
-- 5. Annual Workplan Lines
-- These hold the awarded/active ARWP planning lines.
-- planned_rate = contract/successful bidder rate used for monitoring.
-- planned_amount = planned_quantity * planned_rate.
-- ============================================================

CREATE TABLE IF NOT EXISTS annual_workplan_lines (
    id INT AUTO_INCREMENT PRIMARY KEY,

    workplan_id INT NOT NULL,
    project_id INT NULL,
    road_id INT NOT NULL,
    activity_id INT NOT NULL,

    financial_year VARCHAR(20) NOT NULL,

    lot_no VARCHAR(100) NULL,
    category VARCHAR(100) NULL,
    method VARCHAR(50) NULL,

    chainage_start DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    chainage_end DECIMAL(12,3) NOT NULL DEFAULT 0.000,

    planned_quantity DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    planned_rate DECIMAL(15,2) NOT NULL DEFAULT 0.00,

    planned_amount DECIMAL(20,2)
        GENERATED ALWAYS AS (ROUND((planned_quantity * planned_rate), 2)) STORED,

    remarks TEXT NULL,

    status ENUM('draft', 'approved', 'cancelled') NOT NULL DEFAULT 'draft',

    is_ignored TINYINT(1) NOT NULL DEFAULT 0,

    line_type ENUM(
        'ROAD_WORK',
        'PRELIMINARIES',
        'SITE_BUILDING',
        'GENERAL_ITEM',
        'PROVISIONAL_SUM'
    ) NOT NULL DEFAULT 'ROAD_WORK',

    ignored_reason VARCHAR(255) NULL,
    ignored_by INT NULL,
    ignored_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_workplan_road_activity_chainage (
        workplan_id,
        road_id,
        activity_id,
        chainage_start,
        chainage_end
    ),

    CONSTRAINT fk_awp_lines_workplan
        FOREIGN KEY (workplan_id)
        REFERENCES annual_workplans(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_awp_lines_road
        FOREIGN KEY (road_id)
        REFERENCES roads(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_awp_lines_activity
        FOREIGN KEY (activity_id)
        REFERENCES activities(id)
        ON DELETE CASCADE
);


-- ============================================================
-- 6. Work Instructions
-- Later RE instructions link to planned ARWP lines.
-- ============================================================

CREATE TABLE IF NOT EXISTS work_instructions (
    id INT AUTO_INCREMENT PRIMARY KEY,

    workplan_line_id INT NOT NULL,
    project_id INT NULL,
    road_id INT NOT NULL,
    activity_id INT NOT NULL,

    instruction_number VARCHAR(100) NOT NULL,
    instruction_date DATE NOT NULL,

    instructed_quantity DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    instructed_rate DECIMAL(15,2) NOT NULL DEFAULT 0.00,

    instructed_amount DECIMAL(20,2)
        GENERATED ALWAYS AS (ROUND((instructed_quantity * instructed_rate), 2)) STORED,

    status ENUM('draft', 'issued', 'in_progress', 'completed', 'cancelled')
        NOT NULL DEFAULT 'draft',

    issued_by INT NULL,
    notes TEXT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_instruction_number (instruction_number),

    CONSTRAINT fk_work_instruction_line
        FOREIGN KEY (workplan_line_id)
        REFERENCES annual_workplan_lines(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_work_instruction_road
        FOREIGN KEY (road_id)
        REFERENCES roads(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_work_instruction_activity
        FOREIGN KEY (activity_id)
        REFERENCES activities(id)
        ON DELETE CASCADE
);


-- ============================================================
-- 7. Successful Bidder / Contract Activity Rates
-- These are post-award rates used for compliance monitoring.
-- ============================================================

CREATE TABLE IF NOT EXISTS contract_activity_rates (
    id INT AUTO_INCREMENT PRIMARY KEY,

    project_id INT NULL,
    activity_id INT NOT NULL,

    financial_year VARCHAR(20) NOT NULL,
    region VARCHAR(100) NOT NULL DEFAULT 'Coast',

    contractor_rate DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    krb_rate_at_tender DECIMAL(15,2) NULL,

    source VARCHAR(100) NULL DEFAULT 'Successful Bidder ARWP',
    notes TEXT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_contract_activity_rate (
        project_id,
        activity_id,
        financial_year,
        region
    ),

    CONSTRAINT fk_contract_activity_rates_activity
        FOREIGN KEY (activity_id)
        REFERENCES activities(id)
        ON DELETE CASCADE
);


-- ============================================================
-- 8. Project Roads Link
-- project_roads connects projects to roads.
-- Existing table had project_id, project_name, chainage_from, chainage_to.
-- ============================================================

ALTER TABLE project_roads
ADD COLUMN road_id INT NULL AFTER project_id;

ALTER TABLE project_roads
ADD CONSTRAINT fk_project_roads_road
FOREIGN KEY (road_id)
REFERENCES roads(id)
ON DELETE CASCADE;

ALTER TABLE project_roads
ADD UNIQUE KEY unique_project_road (project_id, road_id);


-- ============================================================
-- 9. ARWP Lot to Project Mapping
-- Projects module stays in charge.
-- This table maps imported ARWP lots/categories to real projects.
-- ============================================================

CREATE TABLE IF NOT EXISTS annual_workplan_project_lots (
    id INT AUTO_INCREMENT PRIMARY KEY,

    workplan_id INT NOT NULL,
    lot_no VARCHAR(100) NOT NULL,
    category VARCHAR(100) NOT NULL,

    project_id INT NOT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_workplan_lot_category (
        workplan_id,
        lot_no,
        category
    ),

    CONSTRAINT fk_awp_lot_workplan
        FOREIGN KEY (workplan_id)
        REFERENCES annual_workplans(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_awp_lot_project
        FOREIGN KEY (project_id)
        REFERENCES projects(id)
        ON DELETE CASCADE
);