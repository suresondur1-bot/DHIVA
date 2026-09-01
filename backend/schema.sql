--
-- PostgreSQL database dump
--

-- Dumped from database version 14.20
-- Dumped by pg_dump version 15.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: update_project_variables_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_project_variables_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_requests (
    id integer NOT NULL,
    org_name text NOT NULL,
    description text,
    admin_name text NOT NULL,
    email text NOT NULL,
    contact text NOT NULL,
    project_name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: access_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.access_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: access_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.access_requests_id_seq OWNED BY public.access_requests.id;


--
-- Name: agent_test_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_test_cases (
    id integer NOT NULL,
    project_id integer,
    name character varying(255) NOT NULL,
    goal text,
    base_url character varying(500),
    type character varying(32) DEFAULT 'ui'::character varying,
    browser character varying(32) DEFAULT 'chrome'::character varying,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    variables jsonb DEFAULT '[]'::jsonb,
    source character varying(32) DEFAULT 'agent'::character varying,
    status character varying(32) DEFAULT 'draft'::character varying,
    approved boolean DEFAULT false,
    promoted_test_case_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_test_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_test_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_test_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_test_cases_id_seq OWNED BY public.agent_test_cases.id;


--
-- Name: api_environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_environments (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    base_url character varying(500) NOT NULL,
    variables jsonb DEFAULT '{}'::jsonb,
    description text,
    org_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    active boolean DEFAULT true
);


--
-- Name: api_environments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_environments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_environments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_environments_id_seq OWNED BY public.api_environments.id;


--
-- Name: api_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tests (
    id integer NOT NULL,
    test_case_id integer,
    method character varying(10) DEFAULT 'GET'::character varying,
    url text,
    headers jsonb DEFAULT '{}'::jsonb,
    body text,
    assertions jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: api_tests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_tests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_tests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_tests_id_seq OWNED BY public.api_tests.id;


--
-- Name: auto_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_sessions (
    id integer NOT NULL,
    user_id integer,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    org_id integer
);


--
-- Name: auto_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_sessions_id_seq OWNED BY public.auto_sessions.id;


--
-- Name: auto_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_users (
    id integer NOT NULL,
    username character varying(100) NOT NULL,
    password_hash text NOT NULL,
    full_name character varying(255),
    email character varying(255),
    role character varying(20) DEFAULT 'tester'::character varying,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    must_change_password boolean DEFAULT false,
    CONSTRAINT auto_users_role_check CHECK (((role)::text = ANY ((ARRAY['superadmin'::character varying, 'admin'::character varying, 'lead'::character varying, 'tester'::character varying, 'viewer'::character varying])::text[])))
);


--
-- Name: auto_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_users_id_seq OWNED BY public.auto_users.id;


--
-- Name: ci_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_api_keys (
    id integer NOT NULL,
    label text NOT NULL,
    api_key text NOT NULL,
    org_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone,
    active boolean DEFAULT true
);


--
-- Name: ci_api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ci_api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ci_api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ci_api_keys_id_seq OWNED BY public.ci_api_keys.id;


--
-- Name: client_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_agents (
    id integer NOT NULL,
    name text NOT NULL,
    ip text,
    token text NOT NULL,
    status text DEFAULT 'offline'::text,
    platform text,
    appium_url text DEFAULT 'http://localhost:4723'::text,
    last_seen timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: client_agents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_agents_id_seq OWNED BY public.client_agents.id;


--
-- Name: custom_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_controls (
    id integer NOT NULL,
    project_id integer,
    control_id text NOT NULL,
    name text NOT NULL,
    recognition jsonb DEFAULT '{}'::jsonb NOT NULL,
    keywords jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: custom_controls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_controls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_controls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_controls_id_seq OWNED BY public.custom_controls.id;


--
-- Name: db_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.db_connections (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    db_type character varying(20) DEFAULT 'postgresql'::character varying NOT NULL,
    host character varying(255) NOT NULL,
    port integer DEFAULT 5432 NOT NULL,
    database character varying(100) NOT NULL,
    username character varying(100) NOT NULL,
    password_enc text DEFAULT ''::text NOT NULL,
    description text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id integer
);


--
-- Name: db_connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.db_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: db_connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.db_connections_id_seq OWNED BY public.db_connections.id;


--
-- Name: heal_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.heal_cache (
    id integer NOT NULL,
    original text NOT NULL,
    healed text NOT NULL,
    hit_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone DEFAULT now()
);


--
-- Name: heal_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.heal_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: heal_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.heal_cache_id_seq OWNED BY public.heal_cache.id;


--
-- Name: jira_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jira_config (
    id integer NOT NULL,
    jira_url text DEFAULT ''::text NOT NULL,
    jira_email text DEFAULT ''::text NOT NULL,
    jira_api_token text DEFAULT ''::text NOT NULL,
    project_key text DEFAULT ''::text NOT NULL,
    val_worktype text DEFAULT 'Bug'::text NOT NULL,
    val_defecttype text DEFAULT 'Functional'::text NOT NULL,
    val_status text DEFAULT 'Open'::text NOT NULL,
    fid_summary text DEFAULT 'summary'::text,
    fid_description text DEFAULT 'description'::text,
    fid_priority text DEFAULT 'priority'::text,
    fid_source text DEFAULT ''::text,
    fid_worktype text DEFAULT ''::text,
    fid_defecttype text DEFAULT ''::text,
    fid_severity text DEFAULT ''::text,
    fid_affectversion text DEFAULT ''::text,
    fid_labels text DEFAULT 'labels'::text,
    severity_options text DEFAULT 'Critical,High,Medium,Low'::text,
    default_severity text DEFAULT 'High'::text,
    default_affectver text DEFAULT ''::text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: jira_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.jira_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jira_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.jira_config_id_seq OWNED BY public.jira_config.id;


--
-- Name: modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modules (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    project_id integer NOT NULL,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: modules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.modules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: modules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.modules_id_seq OWNED BY public.modules.id;


--
-- Name: multilingual_baselines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.multilingual_baselines (
    id integer NOT NULL,
    project_id integer,
    test_case_id integer,
    language character varying(10) NOT NULL,
    url text NOT NULL,
    page_title text,
    elements jsonb NOT NULL,
    captured_by integer,
    captured_at timestamp with time zone DEFAULT now()
);


--
-- Name: multilingual_baselines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.multilingual_baselines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: multilingual_baselines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.multilingual_baselines_id_seq OWNED BY public.multilingual_baselines.id;


--
-- Name: multilingual_ignores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.multilingual_ignores (
    id integer NOT NULL,
    project_id integer,
    test_case_id integer NOT NULL,
    language text,
    selector text,
    base_text text,
    reason text NOT NULL,
    approval_status text DEFAULT 'approved'::text,
    created_by integer,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: multilingual_ignores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.multilingual_ignores_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: multilingual_ignores_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.multilingual_ignores_id_seq OWNED BY public.multilingual_ignores.id;


--
-- Name: multilingual_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.multilingual_results (
    id integer NOT NULL,
    project_id integer,
    test_case_id integer,
    base_language character varying(10) NOT NULL,
    target_language character varying(10) NOT NULL,
    pages jsonb NOT NULL,
    total_elements integer DEFAULT 0,
    translated integer DEFAULT 0,
    not_translated integer DEFAULT 0,
    overflow integer DEFAULT 0,
    overall_score integer DEFAULT 0,
    run_by integer,
    run_at timestamp with time zone DEFAULT now()
);


--
-- Name: multilingual_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.multilingual_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: multilingual_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.multilingual_results_id_seq OWNED BY public.multilingual_results.id;


--
-- Name: org_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_projects (
    org_id integer NOT NULL,
    project_id integer NOT NULL
);


--
-- Name: organisations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organisations (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: organisations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.organisations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: organisations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.organisations_id_seq OWNED BY public.organisations.id;


--
-- Name: project_variables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_variables (
    id integer NOT NULL,
    project_id integer NOT NULL,
    name character varying(100) NOT NULL,
    value text,
    type character varying(20) DEFAULT 'fixed'::character varying NOT NULL,
    description text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: project_variables_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_variables_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_variables_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_variables_id_seq OWNED BY public.project_variables.id;


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    base_url text,
    active boolean DEFAULT true,
    created_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;


--
-- Name: schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedules (
    id integer NOT NULL,
    test_case_id integer,
    cron_expr character varying(100) NOT NULL,
    label character varying(100),
    browser character varying(20) DEFAULT 'chrome'::character varying,
    active boolean DEFAULT true,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    schedule_type character varying(20) DEFAULT 'test'::character varying,
    notify_email character varying(255),
    suite_id integer
);


--
-- Name: schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schedules_id_seq OWNED BY public.schedules.id;


--
-- Name: suite_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suite_runs (
    id integer NOT NULL,
    suite_id integer,
    project_id integer,
    name character varying(255),
    status character varying(20) DEFAULT 'running'::character varying,
    browser character varying(20) DEFAULT 'chrome'::character varying,
    total integer DEFAULT 0,
    passed integer DEFAULT 0,
    failed integer DEFAULT 0,
    run_by integer,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone,
    triggered_by character varying(50) DEFAULT 'manual'::character varying,
    total_tests integer DEFAULT 0,
    passed_tests integer DEFAULT 0,
    failed_tests integer DEFAULT 0,
    completed_at timestamp with time zone,
    run_order jsonb,
    notify_email text,
    CONSTRAINT suite_runs_status_check CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'passed'::character varying, 'failed'::character varying, 'partial'::character varying, 'error'::character varying, 'aborted'::character varying])::text[])))
);


--
-- Name: suite_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.suite_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: suite_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.suite_runs_id_seq OWNED BY public.suite_runs.id;


--
-- Name: test_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_cases (
    id integer NOT NULL,
    suite_id integer,
    project_id integer,
    name character varying(255) NOT NULL,
    description text,
    type character varying(20) DEFAULT 'ui'::character varying,
    browser character varying(20) DEFAULT 'chrome'::character varying,
    base_url text,
    steps jsonb DEFAULT '[]'::jsonb,
    tags text[],
    priority character varying(10) DEFAULT 'medium'::character varying,
    active boolean DEFAULT true,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    variables jsonb DEFAULT '[]'::jsonb,
    api_config jsonb,
    module_id integer,
    is_callable boolean DEFAULT false,
    heal_update boolean DEFAULT false,
    CONSTRAINT test_cases_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[]))),
    CONSTRAINT test_cases_type_check CHECK (((type)::text = ANY ((ARRAY['ui'::character varying, 'api'::character varying])::text[])))
);


--
-- Name: test_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.test_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: test_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.test_cases_id_seq OWNED BY public.test_cases.id;


--
-- Name: test_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_runs (
    id integer NOT NULL,
    test_case_id integer,
    project_id integer,
    status character varying(20) DEFAULT 'queued'::character varying,
    browser character varying(20),
    duration_ms integer,
    steps_total integer DEFAULT 0,
    steps_passed integer DEFAULT 0,
    steps_failed integer DEFAULT 0,
    error_message text,
    logs jsonb DEFAULT '[]'::jsonb,
    screenshots jsonb DEFAULT '[]'::jsonb,
    triggered_by character varying(50) DEFAULT 'manual'::character varying,
    run_by integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    suite_run_id integer,
    parallel_run_id character varying(64),
    parallel_label character varying(100),
    retried boolean DEFAULT false,
    variables jsonb,
    jira_ticket text,
    jira_posted_at timestamp with time zone,
    jira_severity text,
    jira_affect_ver text,
    jira_summary text,
    jira_skipped boolean DEFAULT false,
    visual_bugs jsonb DEFAULT '[]'::jsonb,
    origin_server text,
    CONSTRAINT test_runs_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'passed'::character varying, 'failed'::character varying, 'error'::character varying, 'aborted'::character varying])::text[])))
);


--
-- Name: test_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.test_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: test_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.test_runs_id_seq OWNED BY public.test_runs.id;


--
-- Name: test_suites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_suites (
    id integer NOT NULL,
    project_id integer,
    name character varying(255) NOT NULL,
    description text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    suite_type character varying(20) DEFAULT 'static'::character varying,
    filter_config jsonb
);


--
-- Name: test_suites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.test_suites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: test_suites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.test_suites_id_seq OWNED BY public.test_suites.id;


--
-- Name: user_orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_orgs (
    user_id integer NOT NULL,
    org_id integer NOT NULL
);


--
-- Name: user_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_projects (
    user_id integer NOT NULL,
    project_id integer NOT NULL
);


--
-- Name: visual_baselines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visual_baselines (
    id integer NOT NULL,
    visual_test_id integer,
    file_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: visual_baselines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.visual_baselines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: visual_baselines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.visual_baselines_id_seq OWNED BY public.visual_baselines.id;


--
-- Name: visual_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visual_prompts (
    match_level character varying(20) NOT NULL,
    prompt_text text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: visual_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visual_runs (
    id integer NOT NULL,
    visual_test_id integer,
    status text DEFAULT 'running'::text,
    diff_pct numeric,
    report text,
    baseline_path text,
    actual_path text,
    diff_path text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: visual_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.visual_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: visual_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.visual_runs_id_seq OWNED BY public.visual_runs.id;


--
-- Name: visual_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visual_tests (
    id integer NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    project_id integer,
    mode text DEFAULT 'baseline'::text,
    figma_url text,
    figma_token text,
    threshold numeric DEFAULT 5,
    description text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: visual_tests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.visual_tests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: visual_tests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.visual_tests_id_seq OWNED BY public.visual_tests.id;


--
-- Name: access_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests ALTER COLUMN id SET DEFAULT nextval('public.access_requests_id_seq'::regclass);


--
-- Name: agent_test_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_test_cases ALTER COLUMN id SET DEFAULT nextval('public.agent_test_cases_id_seq'::regclass);


--
-- Name: api_environments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_environments ALTER COLUMN id SET DEFAULT nextval('public.api_environments_id_seq'::regclass);


--
-- Name: api_tests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tests ALTER COLUMN id SET DEFAULT nextval('public.api_tests_id_seq'::regclass);


--
-- Name: auto_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_sessions ALTER COLUMN id SET DEFAULT nextval('public.auto_sessions_id_seq'::regclass);


--
-- Name: auto_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_users ALTER COLUMN id SET DEFAULT nextval('public.auto_users_id_seq'::regclass);


--
-- Name: ci_api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_api_keys ALTER COLUMN id SET DEFAULT nextval('public.ci_api_keys_id_seq'::regclass);


--
-- Name: client_agents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_agents ALTER COLUMN id SET DEFAULT nextval('public.client_agents_id_seq'::regclass);


--
-- Name: custom_controls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_controls ALTER COLUMN id SET DEFAULT nextval('public.custom_controls_id_seq'::regclass);


--
-- Name: db_connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_connections ALTER COLUMN id SET DEFAULT nextval('public.db_connections_id_seq'::regclass);


--
-- Name: heal_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heal_cache ALTER COLUMN id SET DEFAULT nextval('public.heal_cache_id_seq'::regclass);


--
-- Name: jira_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_config ALTER COLUMN id SET DEFAULT nextval('public.jira_config_id_seq'::regclass);


--
-- Name: modules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modules ALTER COLUMN id SET DEFAULT nextval('public.modules_id_seq'::regclass);


--
-- Name: multilingual_baselines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_baselines ALTER COLUMN id SET DEFAULT nextval('public.multilingual_baselines_id_seq'::regclass);


--
-- Name: multilingual_ignores id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_ignores ALTER COLUMN id SET DEFAULT nextval('public.multilingual_ignores_id_seq'::regclass);


--
-- Name: multilingual_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_results ALTER COLUMN id SET DEFAULT nextval('public.multilingual_results_id_seq'::regclass);


--
-- Name: organisations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations ALTER COLUMN id SET DEFAULT nextval('public.organisations_id_seq'::regclass);


--
-- Name: project_variables id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_variables ALTER COLUMN id SET DEFAULT nextval('public.project_variables_id_seq'::regclass);


--
-- Name: projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);


--
-- Name: schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules ALTER COLUMN id SET DEFAULT nextval('public.schedules_id_seq'::regclass);


--
-- Name: suite_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suite_runs ALTER COLUMN id SET DEFAULT nextval('public.suite_runs_id_seq'::regclass);


--
-- Name: test_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases ALTER COLUMN id SET DEFAULT nextval('public.test_cases_id_seq'::regclass);


--
-- Name: test_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_runs ALTER COLUMN id SET DEFAULT nextval('public.test_runs_id_seq'::regclass);


--
-- Name: test_suites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suites ALTER COLUMN id SET DEFAULT nextval('public.test_suites_id_seq'::regclass);


--
-- Name: visual_baselines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_baselines ALTER COLUMN id SET DEFAULT nextval('public.visual_baselines_id_seq'::regclass);


--
-- Name: visual_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_runs ALTER COLUMN id SET DEFAULT nextval('public.visual_runs_id_seq'::regclass);


--
-- Name: visual_tests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_tests ALTER COLUMN id SET DEFAULT nextval('public.visual_tests_id_seq'::regclass);


--
-- Name: access_requests access_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_pkey PRIMARY KEY (id);


--
-- Name: agent_test_cases agent_test_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_test_cases
    ADD CONSTRAINT agent_test_cases_pkey PRIMARY KEY (id);


--
-- Name: api_environments api_environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_environments
    ADD CONSTRAINT api_environments_pkey PRIMARY KEY (id);


--
-- Name: api_tests api_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tests
    ADD CONSTRAINT api_tests_pkey PRIMARY KEY (id);


--
-- Name: auto_sessions auto_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_sessions
    ADD CONSTRAINT auto_sessions_pkey PRIMARY KEY (id);


--
-- Name: auto_sessions auto_sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_sessions
    ADD CONSTRAINT auto_sessions_token_key UNIQUE (token);


--
-- Name: auto_users auto_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_users
    ADD CONSTRAINT auto_users_pkey PRIMARY KEY (id);


--
-- Name: auto_users auto_users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_users
    ADD CONSTRAINT auto_users_username_key UNIQUE (username);


--
-- Name: ci_api_keys ci_api_keys_api_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_api_keys
    ADD CONSTRAINT ci_api_keys_api_key_key UNIQUE (api_key);


--
-- Name: ci_api_keys ci_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_api_keys
    ADD CONSTRAINT ci_api_keys_pkey PRIMARY KEY (id);


--
-- Name: client_agents client_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_agents
    ADD CONSTRAINT client_agents_pkey PRIMARY KEY (id);


--
-- Name: client_agents client_agents_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_agents
    ADD CONSTRAINT client_agents_token_key UNIQUE (token);


--
-- Name: custom_controls custom_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_controls
    ADD CONSTRAINT custom_controls_pkey PRIMARY KEY (id);


--
-- Name: custom_controls custom_controls_project_id_control_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_controls
    ADD CONSTRAINT custom_controls_project_id_control_id_key UNIQUE (project_id, control_id);


--
-- Name: db_connections db_connections_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_connections
    ADD CONSTRAINT db_connections_name_key UNIQUE (name);


--
-- Name: db_connections db_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_connections
    ADD CONSTRAINT db_connections_pkey PRIMARY KEY (id);


--
-- Name: heal_cache heal_cache_original_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heal_cache
    ADD CONSTRAINT heal_cache_original_key UNIQUE (original);


--
-- Name: heal_cache heal_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heal_cache
    ADD CONSTRAINT heal_cache_pkey PRIMARY KEY (id);


--
-- Name: jira_config jira_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_config
    ADD CONSTRAINT jira_config_pkey PRIMARY KEY (id);


--
-- Name: modules modules_name_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modules
    ADD CONSTRAINT modules_name_project_id_key UNIQUE (name, project_id);


--
-- Name: modules modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modules
    ADD CONSTRAINT modules_pkey PRIMARY KEY (id);


--
-- Name: multilingual_baselines multilingual_baselines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_baselines
    ADD CONSTRAINT multilingual_baselines_pkey PRIMARY KEY (id);


--
-- Name: multilingual_ignores multilingual_ignores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_ignores
    ADD CONSTRAINT multilingual_ignores_pkey PRIMARY KEY (id);


--
-- Name: multilingual_results multilingual_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_results
    ADD CONSTRAINT multilingual_results_pkey PRIMARY KEY (id);


--
-- Name: org_projects org_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_projects
    ADD CONSTRAINT org_projects_pkey PRIMARY KEY (org_id, project_id);


--
-- Name: organisations organisations_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations
    ADD CONSTRAINT organisations_name_key UNIQUE (name);


--
-- Name: organisations organisations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations
    ADD CONSTRAINT organisations_pkey PRIMARY KEY (id);


--
-- Name: project_variables project_variables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_variables
    ADD CONSTRAINT project_variables_pkey PRIMARY KEY (id);


--
-- Name: project_variables project_variables_project_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_variables
    ADD CONSTRAINT project_variables_project_id_name_key UNIQUE (project_id, name);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: schedules schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);


--
-- Name: suite_runs suite_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suite_runs
    ADD CONSTRAINT suite_runs_pkey PRIMARY KEY (id);


--
-- Name: test_cases test_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_pkey PRIMARY KEY (id);


--
-- Name: test_runs test_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_runs
    ADD CONSTRAINT test_runs_pkey PRIMARY KEY (id);


--
-- Name: test_suites test_suites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suites
    ADD CONSTRAINT test_suites_pkey PRIMARY KEY (id);


--
-- Name: user_orgs user_orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_orgs
    ADD CONSTRAINT user_orgs_pkey PRIMARY KEY (user_id, org_id);


--
-- Name: user_projects user_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_projects
    ADD CONSTRAINT user_projects_pkey PRIMARY KEY (user_id, project_id);


--
-- Name: visual_baselines visual_baselines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_baselines
    ADD CONSTRAINT visual_baselines_pkey PRIMARY KEY (id);


--
-- Name: visual_prompts visual_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_prompts
    ADD CONSTRAINT visual_prompts_pkey PRIMARY KEY (match_level);


--
-- Name: visual_runs visual_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_runs
    ADD CONSTRAINT visual_runs_pkey PRIMARY KEY (id);


--
-- Name: visual_tests visual_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_tests
    ADD CONSTRAINT visual_tests_pkey PRIMARY KEY (id);


--
-- Name: idx_access_requests_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_requests_created_at ON public.access_requests USING btree (created_at);


--
-- Name: idx_access_requests_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_requests_email ON public.access_requests USING btree (email);


--
-- Name: idx_access_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_requests_status ON public.access_requests USING btree (status);


--
-- Name: idx_agent_test_cases_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_test_cases_created ON public.agent_test_cases USING btree (created_at DESC);


--
-- Name: idx_agent_test_cases_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_test_cases_project ON public.agent_test_cases USING btree (project_id);


--
-- Name: idx_api_envs_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_envs_active ON public.api_environments USING btree (active);


--
-- Name: idx_api_envs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_envs_org ON public.api_environments USING btree (org_id);


--
-- Name: idx_auto_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auto_sessions_expires ON public.auto_sessions USING btree (expires_at);


--
-- Name: idx_auto_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auto_sessions_token ON public.auto_sessions USING btree (token);


--
-- Name: idx_ci_api_keys_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ci_api_keys_key ON public.ci_api_keys USING btree (api_key);


--
-- Name: idx_db_connections_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_db_connections_name ON public.db_connections USING btree (name);


--
-- Name: idx_db_connections_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_db_connections_org_id ON public.db_connections USING btree (org_id);


--
-- Name: idx_ml_baselines_tc_lang; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ml_baselines_tc_lang ON public.multilingual_baselines USING btree (test_case_id, language);


--
-- Name: idx_ml_ignores_tc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ml_ignores_tc ON public.multilingual_ignores USING btree (test_case_id);


--
-- Name: idx_ml_results_tc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ml_results_tc ON public.multilingual_results USING btree (test_case_id, base_language, target_language);


--
-- Name: idx_modules_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_modules_project ON public.modules USING btree (project_id);


--
-- Name: idx_org_projects_oid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_projects_oid ON public.org_projects USING btree (org_id);


--
-- Name: idx_org_projects_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_projects_org ON public.org_projects USING btree (org_id);


--
-- Name: idx_org_projects_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_projects_org_id ON public.org_projects USING btree (org_id);


--
-- Name: idx_org_projects_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_projects_project ON public.org_projects USING btree (project_id);


--
-- Name: idx_project_vars_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_vars_project ON public.project_variables USING btree (project_id);


--
-- Name: idx_runs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_created ON public.test_runs USING btree (created_at DESC);


--
-- Name: idx_runs_parallel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_parallel ON public.test_runs USING btree (parallel_run_id) WHERE (parallel_run_id IS NOT NULL);


--
-- Name: idx_runs_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_project ON public.test_runs USING btree (project_id);


--
-- Name: idx_runs_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_started ON public.test_runs USING btree (started_at DESC);


--
-- Name: idx_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_status ON public.test_runs USING btree (status);


--
-- Name: idx_runs_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_status_created ON public.test_runs USING btree (status, created_at DESC);


--
-- Name: idx_runs_suite_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_suite_run ON public.test_runs USING btree (suite_run_id) WHERE (suite_run_id IS NOT NULL);


--
-- Name: idx_runs_test_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_test_case ON public.test_runs USING btree (test_case_id);


--
-- Name: idx_schedules_suite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_suite ON public.schedules USING btree (suite_id);


--
-- Name: idx_schedules_test; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_test ON public.schedules USING btree (test_case_id);


--
-- Name: idx_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_expires ON public.auto_sessions USING btree (expires_at);


--
-- Name: idx_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_token ON public.auto_sessions USING btree (token);


--
-- Name: idx_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_user ON public.auto_sessions USING btree (user_id);


--
-- Name: idx_suite_runs_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suite_runs_started ON public.suite_runs USING btree (started_at DESC);


--
-- Name: idx_suite_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suite_runs_status ON public.suite_runs USING btree (status);


--
-- Name: idx_suite_runs_suite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suite_runs_suite ON public.suite_runs USING btree (suite_id);


--
-- Name: idx_suite_runs_suite_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suite_runs_suite_id ON public.suite_runs USING btree (suite_id);


--
-- Name: idx_suites_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suites_project ON public.test_suites USING btree (project_id) WHERE (active = true);


--
-- Name: idx_tc_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tc_created ON public.test_cases USING btree (created_at DESC);


--
-- Name: idx_tc_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tc_module ON public.test_cases USING btree (module_id);


--
-- Name: idx_tc_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tc_name_trgm ON public.test_cases USING gin (to_tsvector('english'::regconfig, (name)::text));


--
-- Name: idx_tc_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tc_priority ON public.test_cases USING btree (priority);


--
-- Name: idx_tc_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tc_project ON public.test_cases USING btree (project_id) WHERE (active = true);


--
-- Name: idx_tc_suite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tc_suite ON public.test_cases USING btree (suite_id) WHERE (active = true);


--
-- Name: idx_test_cases_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_cases_active ON public.test_cases USING btree (project_id) WHERE (active = true);


--
-- Name: idx_test_cases_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_cases_created_at ON public.test_cases USING btree (created_at DESC);


--
-- Name: idx_test_cases_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_cases_module ON public.test_cases USING btree (module_id);


--
-- Name: idx_test_cases_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_cases_priority ON public.test_cases USING btree (priority);


--
-- Name: idx_test_cases_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_cases_project ON public.test_cases USING btree (project_id) WHERE (active = true);


--
-- Name: idx_test_cases_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_cases_project_id ON public.test_cases USING btree (project_id);


--
-- Name: idx_test_cases_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_cases_updated_at ON public.test_cases USING btree (updated_at DESC);


--
-- Name: idx_test_runs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_created_at ON public.test_runs USING btree (created_at DESC);


--
-- Name: idx_test_runs_parallel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_parallel ON public.test_runs USING btree (parallel_run_id);


--
-- Name: idx_test_runs_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_project ON public.test_runs USING btree (project_id);


--
-- Name: idx_test_runs_project_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_project_created ON public.test_runs USING btree (project_id, created_at DESC);


--
-- Name: idx_test_runs_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_project_id ON public.test_runs USING btree (project_id);


--
-- Name: idx_test_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_status ON public.test_runs USING btree (status);


--
-- Name: idx_test_runs_suite_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_suite_run ON public.test_runs USING btree (suite_run_id);


--
-- Name: idx_test_runs_suite_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_suite_run_id ON public.test_runs USING btree (suite_run_id);


--
-- Name: idx_test_runs_test_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_test_case ON public.test_runs USING btree (test_case_id);


--
-- Name: idx_test_runs_test_case_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_runs_test_case_id ON public.test_runs USING btree (test_case_id);


--
-- Name: idx_user_orgs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_orgs_org ON public.user_orgs USING btree (org_id);


--
-- Name: idx_user_orgs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_orgs_user ON public.user_orgs USING btree (user_id);


--
-- Name: idx_user_orgs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_orgs_user_id ON public.user_orgs USING btree (user_id);


--
-- Name: idx_user_projects_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_projects_project ON public.user_projects USING btree (project_id);


--
-- Name: idx_user_projects_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_projects_uid ON public.user_projects USING btree (user_id);


--
-- Name: idx_user_projects_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_projects_user ON public.user_projects USING btree (user_id);


--
-- Name: idx_user_projects_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_projects_user_id ON public.user_projects USING btree (user_id);


--
-- Name: project_variables trg_project_variables_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_project_variables_updated BEFORE UPDATE ON public.project_variables FOR EACH ROW EXECUTE FUNCTION public.update_project_variables_timestamp();


--
-- Name: api_environments api_environments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_environments
    ADD CONSTRAINT api_environments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.auto_users(id);


--
-- Name: api_environments api_environments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_environments
    ADD CONSTRAINT api_environments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: api_tests api_tests_test_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tests
    ADD CONSTRAINT api_tests_test_case_id_fkey FOREIGN KEY (test_case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;


--
-- Name: auto_sessions auto_sessions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_sessions
    ADD CONSTRAINT auto_sessions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE SET NULL;


--
-- Name: auto_sessions auto_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_sessions
    ADD CONSTRAINT auto_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auto_users(id) ON DELETE CASCADE;


--
-- Name: db_connections db_connections_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_connections
    ADD CONSTRAINT db_connections_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.auto_users(id);


--
-- Name: db_connections db_connections_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_connections
    ADD CONSTRAINT db_connections_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE SET NULL;


--
-- Name: modules modules_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modules
    ADD CONSTRAINT modules_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: multilingual_baselines multilingual_baselines_captured_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_baselines
    ADD CONSTRAINT multilingual_baselines_captured_by_fkey FOREIGN KEY (captured_by) REFERENCES public.auto_users(id);


--
-- Name: multilingual_baselines multilingual_baselines_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_baselines
    ADD CONSTRAINT multilingual_baselines_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: multilingual_baselines multilingual_baselines_test_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_baselines
    ADD CONSTRAINT multilingual_baselines_test_case_id_fkey FOREIGN KEY (test_case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;


--
-- Name: multilingual_results multilingual_results_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_results
    ADD CONSTRAINT multilingual_results_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: multilingual_results multilingual_results_test_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multilingual_results
    ADD CONSTRAINT multilingual_results_test_case_id_fkey FOREIGN KEY (test_case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;


--
-- Name: org_projects org_projects_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_projects
    ADD CONSTRAINT org_projects_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: org_projects org_projects_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_projects
    ADD CONSTRAINT org_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_variables project_variables_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_variables
    ADD CONSTRAINT project_variables_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.auto_users(id);


--
-- Name: project_variables project_variables_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_variables
    ADD CONSTRAINT project_variables_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.auto_users(id);


--
-- Name: schedules schedules_suite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_suite_id_fkey FOREIGN KEY (suite_id) REFERENCES public.test_suites(id);


--
-- Name: schedules schedules_test_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_test_case_id_fkey FOREIGN KEY (test_case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;


--
-- Name: suite_runs suite_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suite_runs
    ADD CONSTRAINT suite_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: suite_runs suite_runs_run_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suite_runs
    ADD CONSTRAINT suite_runs_run_by_fkey FOREIGN KEY (run_by) REFERENCES public.auto_users(id);


--
-- Name: suite_runs suite_runs_suite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suite_runs
    ADD CONSTRAINT suite_runs_suite_id_fkey FOREIGN KEY (suite_id) REFERENCES public.test_suites(id);


--
-- Name: test_cases test_cases_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.auto_users(id);


--
-- Name: test_cases test_cases_module_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_module_id_fkey FOREIGN KEY (module_id) REFERENCES public.modules(id) ON DELETE SET NULL;


--
-- Name: test_cases test_cases_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: test_cases test_cases_suite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_suite_id_fkey FOREIGN KEY (suite_id) REFERENCES public.test_suites(id) ON DELETE CASCADE;


--
-- Name: test_runs test_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_runs
    ADD CONSTRAINT test_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: test_runs test_runs_run_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_runs
    ADD CONSTRAINT test_runs_run_by_fkey FOREIGN KEY (run_by) REFERENCES public.auto_users(id);


--
-- Name: test_runs test_runs_suite_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_runs
    ADD CONSTRAINT test_runs_suite_run_id_fkey FOREIGN KEY (suite_run_id) REFERENCES public.suite_runs(id);


--
-- Name: test_runs test_runs_test_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_runs
    ADD CONSTRAINT test_runs_test_case_id_fkey FOREIGN KEY (test_case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;


--
-- Name: test_suites test_suites_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suites
    ADD CONSTRAINT test_suites_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: user_orgs user_orgs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_orgs
    ADD CONSTRAINT user_orgs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: user_orgs user_orgs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_orgs
    ADD CONSTRAINT user_orgs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auto_users(id) ON DELETE CASCADE;


--
-- Name: user_projects user_projects_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_projects
    ADD CONSTRAINT user_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: user_projects user_projects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_projects
    ADD CONSTRAINT user_projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auto_users(id) ON DELETE CASCADE;


--
-- Name: visual_baselines visual_baselines_visual_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_baselines
    ADD CONSTRAINT visual_baselines_visual_test_id_fkey FOREIGN KEY (visual_test_id) REFERENCES public.visual_tests(id) ON DELETE CASCADE;


--
-- Name: visual_runs visual_runs_visual_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_runs
    ADD CONSTRAINT visual_runs_visual_test_id_fkey FOREIGN KEY (visual_test_id) REFERENCES public.visual_tests(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

