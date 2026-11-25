// Lights Out: the permission model of the database, written down (T5).
// It was read from the replayed local database (all migrations applied) and is checked two ways:
//   * tests/api-local/privilege-snapshot.spec.js compares it with the live catalog, so any new table, grant or function
//     permission makes a test fail until a person has reviewed it and updated this file;
//   * the API tests use it to try every table and every function as every kind of user.
// To change it deliberately: run the snapshot test, read what changed, and edit the lists below in the same commit.

// Every table in schema public. All of them have row level security switched on.
const TABLES = [
  "driver_substitution_sessions", "driver_substitutions", "drivers", "events",
  "grid_penalties", "group_members", "groups", "import_log",
  "player_notifications", "prediction_corrections", "predictions", "profiles",
  "push_log", "push_notice_log", "push_subscriptions", "results",
  "scores", "season_prediction_log", "season_predictions", "season_results",
  "season_scores", "sessions"
];

// What an anonymous visitor (publishable key, nobody signed in) may READ. They can read nothing else and write nothing.
const ANON_READABLE = [
  "drivers", "events", "prediction_windows", "sessions"
];

// Tables a signed-in user may READ (rows are still filtered by policies). Nobody may write a table directly: all writes go through functions.
const SIGNED_IN_READABLE = [
  "driver_substitution_sessions", "driver_substitutions", "drivers", "events",
  "grid_penalties", "group_members", "leaderboard", "player_achievements",
  "player_achievements_all", "player_event_progress", "player_notifications", "player_season_stats",
  "player_session_stats", "player_xp", "prediction_corrections", "prediction_windows",
  "predictions", "profiles", "push_subscriptions", "results",
  "scores", "season_prediction_log", "season_prediction_windows", "season_predictions",
  "season_results", "season_scores", "sessions"
];

// Tables with no client access at all (not even SELECT): only the server side can use them.
const NO_CLIENT_ACCESS = [
  "groups", "import_log", "push_log", "push_notice_log"
];

// Tables that can only be added to: a trigger refuses every UPDATE and DELETE.
const APPEND_ONLY_TABLES = [
  "driver_substitution_sessions", "driver_substitutions", "grid_penalties", "prediction_corrections"
];

// Functions a signed-in user may call (anonymous visitors may call none). Each is SECURITY DEFINER with an empty search_path.
const ADMIN_FUNCTIONS = [
  "admin_approve_result", "admin_approve_season_result", "admin_correct_predictions", "admin_enter_manual_result",
  "admin_overview", "admin_pending_count", "admin_preview_corrections", "admin_preview_grid_penalty",
  "admin_preview_substitution", "admin_register_grid_penalty", "admin_register_substitution", "admin_reject_result",
  "admin_reject_season_result", "admin_revert_correction", "admin_revert_substitution", "admin_revoke_grid_penalty",
  "admin_save_result_edit", "admin_save_season_result", "admin_season_overview", "admin_set_season_prediction",
  "admin_weekend_check"
];
const PLAYER_FUNCTIONS = [
  "is_admin", "is_group_member", "is_prediction_locked", "join_group",
  "mark_notifications_read", "prediction_form_lineup", "remove_push_subscription", "save_push_subscription",
  "season_picks_closed", "session_lineup", "set_avatar", "shares_group_with",
  "submit_prediction", "submit_season_prediction"
];

// Internal functions: not callable by any client, only by the server side and by other functions.
const INTERNAL_FUNCTIONS = [
  "approve_result", "calc_points", "calc_season_points", "check_drivers",
  "check_pick_drivers", "due_push_notices", "due_push_reminders", "enter_result",
  "jarr", "lo_is_late", "lo_late_factor", "lo_late_from",
  "lo_notify_change", "lo_score", "picks_array", "picks_driver_ids",
  "prediction_dnf_ok", "recalculate_scores", "recalculate_season_scores", "rescore_prediction",
  "result_dnf_ok", "session_has_grid_penalty", "session_lineup_external", "session_lineup_state",
  "validate_session_data"
];

// Harmless dummy arguments that make PostgREST find each function, so a refusal is a PERMISSION refusal and not "no such function".
const DUMMY_ARGS = {
  "admin_approve_result": {
    "p_result_id": "00000000-0000-4000-8000-000000000000"
  },
  "admin_approve_season_result": {
    "p_result_id": "00000000-0000-4000-8000-000000000000"
  },
  "admin_correct_predictions": {
    "p_session_id": "x",
    "p_items": {},
    "p_reason": "x",
    "p_related_substitution": "00000000-0000-4000-8000-000000000000",
    "p_related_penalty": "00000000-0000-4000-8000-000000000000"
  },
  "admin_enter_manual_result": {
    "p_session_id": "x",
    "p_data": {}
  },
  "admin_overview": {},
  "admin_pending_count": {},
  "admin_preview_corrections": {
    "p_session_id": "x"
  },
  "admin_preview_grid_penalty": {
    "p_session_id": "x"
  },
  "admin_preview_substitution": {
    "p_event_id": "x",
    "p_out_driver": "x",
    "p_in_driver": "x"
  },
  "admin_register_grid_penalty": {
    "p_session_id": "x",
    "p_driver": "x",
    "p_penalty_type": "x",
    "p_places": 1,
    "p_original": 1,
    "p_adjusted": 1,
    "p_reason": "x",
    "p_reference": "x",
    "p_confirm_unknown": false
  },
  "admin_register_substitution": {
    "p_event_id": "x",
    "p_out_driver": "x",
    "p_in_driver": "x",
    "p_new_driver": {},
    "p_session_ids": [],
    "p_confirm_unknown": [],
    "p_note": "x"
  },
  "admin_reject_result": {
    "p_result_id": "00000000-0000-4000-8000-000000000000"
  },
  "admin_reject_season_result": {
    "p_result_id": "00000000-0000-4000-8000-000000000000"
  },
  "admin_revert_correction": {
    "p_correction_id": "00000000-0000-4000-8000-000000000000",
    "p_reason": "x"
  },
  "admin_revert_substitution": {
    "p_substitution_id": "00000000-0000-4000-8000-000000000000",
    "p_reason": "x",
    "p_session_ids": [],
    "p_confirm_unknown": []
  },
  "admin_revoke_grid_penalty": {
    "p_penalty_id": "00000000-0000-4000-8000-000000000000",
    "p_reason": "x",
    "p_replacement": {}
  },
  "admin_save_result_edit": {
    "p_result_id": "00000000-0000-4000-8000-000000000000",
    "p_data": {}
  },
  "admin_save_season_result": {
    "p_season": 1,
    "p_drivers": [],
    "p_teams": []
  },
  "admin_season_overview": {},
  "admin_set_season_prediction": {
    "p_user": "00000000-0000-4000-8000-000000000000",
    "p_season": 1,
    "p_driver": "x",
    "p_team": "x",
    "p_reason": "x"
  },
  "admin_weekend_check": {
    "p_event_id": "x"
  },
  "approve_result": {
    "p_result_id": "00000000-0000-4000-8000-000000000000",
    "p_approved_by": "00000000-0000-4000-8000-000000000000"
  },
  "calc_points": {
    "p_type": "x",
    "p_picks": {},
    "p_actual": {}
  },
  "calc_season_points": {
    "p_driver": "x",
    "p_team": "x",
    "p_half": false,
    "p_drivers": [],
    "p_teams": []
  },
  "check_drivers": {
    "p_ids": [],
    "p_season": 1,
    "p_only_active": false
  },
  "check_pick_drivers": {
    "p_ids": [],
    "p_season": 1,
    "p_only_active": false,
    "p_pool": []
  },
  "due_push_notices": {
    "p_now": "2030-01-01T00:00:00Z",
    "p_max_age": "1 day"
  },
  "due_push_reminders": {
    "p_now": "2030-01-01T00:00:00Z"
  },
  "enter_result": {
    "p_session_id": "x",
    "p_data": {},
    "p_source": "x"
  },
  "is_admin": {},
  "is_group_member": {
    "p_group_id": "00000000-0000-4000-8000-000000000000"
  },
  "is_prediction_locked": {
    "p_session_id": "x"
  },
  "jarr": {
    "p_j": {},
    "p_key": "x"
  },
  "join_group": {
    "p_invite_code": "x",
    "p_display_name": "x"
  },
  "lo_is_late": {
    "p_session_id": "x",
    "p_updated_at": "2030-01-01T00:00:00Z"
  },
  "lo_late_factor": {},
  "lo_late_from": {
    "p_session_id": "x"
  },
  "lo_notify_change": {
    "p_kind": "x",
    "p_source": "00000000-0000-4000-8000-000000000000",
    "p_event_id": "x",
    "p_session_ids": [],
    "p_payload": {}
  },
  "lo_score": {
    "p_session_id": "x",
    "p_picks": {},
    "p_actual": {},
    "p_updated_at": "2030-01-01T00:00:00Z"
  },
  "mark_notifications_read": {
    "p_ids": []
  },
  "picks_array": {
    "p_data": {},
    "p_key": "x",
    "p_size": 1
  },
  "picks_driver_ids": {
    "p_picks": {}
  },
  "prediction_dnf_ok": {
    "p_picks": {}
  },
  "prediction_form_lineup": {
    "p_session_id": "x"
  },
  "recalculate_scores": {
    "p_session_id": "x"
  },
  "recalculate_season_scores": {
    "p_season": 1
  },
  "remove_push_subscription": {
    "p_endpoint": "x"
  },
  "rescore_prediction": {
    "p_user": "00000000-0000-4000-8000-000000000000",
    "p_session": "x"
  },
  "result_dnf_ok": {
    "p_data": {}
  },
  "save_push_subscription": {
    "p_endpoint": "x",
    "p_p256dh": "x",
    "p_auth": "x",
    "p_user_agent": "x"
  },
  "season_picks_closed": {
    "p_season": 1,
    "p_half": false
  },
  "session_has_grid_penalty": {
    "p_session_id": "x"
  },
  "session_lineup": {
    "p_session_id": "x"
  },
  "session_lineup_external": {
    "p_session_id": "x"
  },
  "session_lineup_state": {
    "p_session_id": "x"
  },
  "set_avatar": {
    "p_avatar": "x"
  },
  "shares_group_with": {
    "p_user_id": "00000000-0000-4000-8000-000000000000"
  },
  "submit_prediction": {
    "p_session_id": "x",
    "p_picks": {}
  },
  "submit_season_prediction": {
    "p_season": 1,
    "p_driver": "x",
    "p_team": "x"
  },
  "validate_session_data": {
    "p_type": "x",
    "p_data": {},
    "p_season": 1,
    "p_is_result": false,
    "p_lineup": [],
    "p_stand_ins": {}
  }
};

// A plain column of every table (the first one that is not auto-numbered or generated), so a refused write is refused for PERMISSION
// and not for "cannot write to that column".
const PLAIN_COLUMN = {
  "driver_substitution_sessions": "substitution_id",
  "driver_substitutions": "id",
  "drivers": "id",
  "events": "id",
  "grid_penalties": "id",
  "group_members": "group_id",
  "groups": "id",
  "import_log": "id",
  "player_notifications": "id",
  "prediction_corrections": "id",
  "predictions": "id",
  "profiles": "id",
  "push_log": "endpoint",
  "push_notice_log": "endpoint",
  "push_subscriptions": "endpoint",
  "results": "id",
  "scores": "user_id",
  "season_prediction_log": "id",
  "season_predictions": "user_id",
  "season_results": "id",
  "season_scores": "user_id",
  "sessions": "id"
};

// Admin functions that refuse non-admins with their own wording instead of "Admins only".
const ADMIN_REFUSAL = { admin_weekend_check: "Only an admin can run the weekend check" };

module.exports = { TABLES, ANON_READABLE, SIGNED_IN_READABLE, NO_CLIENT_ACCESS, APPEND_ONLY_TABLES, ADMIN_FUNCTIONS, PLAYER_FUNCTIONS, INTERNAL_FUNCTIONS, DUMMY_ARGS, PLAIN_COLUMN, ADMIN_REFUSAL };
