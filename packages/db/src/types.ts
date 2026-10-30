// Hand-written to match `supabase gen types typescript` output for supabase/migrations (M1 + M2 + M4 social + M3 phase 2).
// Regenerate against a real project with `pnpm --filter @rally/db gen:types` once one is linked;
// keep this file in that exact shape so the swap is a no-op for consumers.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      achievements: {
        Row: {
          created_at: string
          description: string
          game_id: string
          hidden: boolean
          icon: string | null
          id: string
          key: string
          title: string
        }
        Insert: {
          created_at?: string
          description?: string
          game_id: string
          hidden?: boolean
          icon?: string | null
          id?: string
          key: string
          title: string
        }
        Update: {
          created_at?: string
          description?: string
          game_id?: string
          hidden?: boolean
          icon?: string | null
          id?: string
          key?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "achievements_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      banned_words: {
        Row: {
          created_at: string
          word: string
        }
        Insert: {
          created_at?: string
          word: string
        }
        Update: {
          created_at?: string
          word?: string
        }
        Relationships: []
      }
      blocks: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      default_avatars: {
        Row: {
          path: string
          sort: number
        }
        Insert: {
          path: string
          sort: number
        }
        Update: {
          path?: string
          sort?: number
        }
        Relationships: []
      }
      favorites: {
        Row: {
          created_at: string
          game_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          game_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          game_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "favorites_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "favorites_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          accepted_at: string | null
          created_at: string
          friend_id: string
          status: Database["public"]["Enums"]["friendship_status"]
          user_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          friend_id: string
          status?: Database["public"]["Enums"]["friendship_status"]
          user_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          friend_id?: string
          status?: Database["public"]["Enums"]["friendship_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "friendships_friend_id_fkey"
            columns: ["friend_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      game_consents: {
        Row: {
          game_id: string
          granted_at: string
          user_id: string
        }
        Insert: {
          game_id: string
          granted_at?: string
          user_id: string
        }
        Update: {
          game_id?: string
          granted_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_consents_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_consents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      game_rooms: {
        Row: {
          clients: number
          code: string | null
          created_at: string
          game_id: string
          locked: boolean
          max_clients: number
          name: string
          phase: string | null
          player_ids: string[]
          private: boolean
          room_id: string
          room_name: string
          server_version: number
          updated_at: string
        }
        Insert: {
          clients?: number
          code?: string | null
          created_at?: string
          game_id: string
          locked?: boolean
          max_clients: number
          name?: string
          phase?: string | null
          player_ids?: string[]
          private?: boolean
          room_id: string
          room_name: string
          server_version?: number
          updated_at?: string
        }
        Update: {
          clients?: number
          code?: string | null
          created_at?: string
          game_id?: string
          locked?: boolean
          max_clients?: number
          name?: string
          phase?: string | null
          player_ids?: string[]
          private?: boolean
          room_id?: string
          room_name?: string
          server_version?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_rooms_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      game_saves: {
        Row: {
          data: Json
          game_id: string
          slot: string
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          data: Json
          game_id: string
          slot: string
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          data?: Json
          game_id?: string
          slot?: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "game_saves_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_saves_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      game_stats: {
        Row: {
          best_score: number | null
          game_id: string
          last_played_at: string | null
          losses: number
          playtime_s: number
          plays: number
          user_id: string
          wins: number
        }
        Insert: {
          best_score?: number | null
          game_id: string
          last_played_at?: string | null
          losses?: number
          playtime_s?: number
          plays?: number
          user_id: string
          wins?: number
        }
        Update: {
          best_score?: number | null
          game_id?: string
          last_played_at?: string | null
          losses?: number
          playtime_s?: number
          plays?: number
          user_id?: string
          wins?: number
        }
        Relationships: [
          {
            foreignKeyName: "game_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_stats_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      game_versions: {
        Row: {
          entry_url: string
          game_id: string
          id: string
          manifest: Json
          published_at: string
          sha256: string
          size_bytes: number
          version: string
        }
        Insert: {
          entry_url: string
          game_id: string
          id?: string
          manifest: Json
          published_at?: string
          sha256: string
          size_bytes?: number
          version: string
        }
        Update: {
          entry_url?: string
          game_id?: string
          id?: string
          manifest?: Json
          published_at?: string
          sha256?: string
          size_bytes?: number
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_versions_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      game_visits_daily: {
        Row: {
          day: string
          game_id: string
          visits: number
        }
        Insert: {
          day: string
          game_id: string
          visits?: number
        }
        Update: {
          day?: string
          game_id?: string
          visits?: number
        }
        Relationships: [
          {
            foreignKeyName: "game_visits_daily_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      games: {
        Row: {
          age_rating: Database["public"]["Enums"]["age_rating"]
          cover_url: string | null
          created_at: string
          current_version_id: string | null
          description: string
          engine: Database["public"]["Enums"]["game_engine"]
          featured_rank: number | null
          genres: string[]
          icon_url: string | null
          id: string
          max_players: number
          min_app_version: string
          min_players: number
          modes: Database["public"]["Enums"]["game_mode"][]
          orientation: Database["public"]["Enums"]["game_orientation"]
          screenshots: string[]
          status: Database["public"]["Enums"]["game_status"]
          title: string
          updated_at: string
          visits: number
        }
        Insert: {
          age_rating?: Database["public"]["Enums"]["age_rating"]
          cover_url?: string | null
          created_at?: string
          current_version_id?: string | null
          description?: string
          engine: Database["public"]["Enums"]["game_engine"]
          featured_rank?: number | null
          genres?: string[]
          icon_url?: string | null
          id: string
          max_players?: number
          min_app_version?: string
          min_players?: number
          modes?: Database["public"]["Enums"]["game_mode"][]
          orientation?: Database["public"]["Enums"]["game_orientation"]
          screenshots?: string[]
          status?: Database["public"]["Enums"]["game_status"]
          title: string
          updated_at?: string
          visits?: number
        }
        Update: {
          age_rating?: Database["public"]["Enums"]["age_rating"]
          cover_url?: string | null
          created_at?: string
          current_version_id?: string | null
          description?: string
          engine?: Database["public"]["Enums"]["game_engine"]
          featured_rank?: number | null
          genres?: string[]
          icon_url?: string | null
          id?: string
          max_players?: number
          min_app_version?: string
          min_players?: number
          modes?: Database["public"]["Enums"]["game_mode"][]
          orientation?: Database["public"]["Enums"]["game_orientation"]
          screenshots?: string[]
          status?: Database["public"]["Enums"]["game_status"]
          title?: string
          updated_at?: string
          visits?: number
        }
        Relationships: [
          {
            foreignKeyName: "games_current_version_fk"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "game_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      leaderboard_entries: {
        Row: {
          leaderboard_id: string
          period_key: string
          score: number
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          leaderboard_id: string
          period_key: string
          score: number
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          leaderboard_id?: string
          period_key?: string
          score?: number
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leaderboard_entries_leaderboard_id_fkey"
            columns: ["leaderboard_id"]
            isOneToOne: false
            referencedRelation: "leaderboards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leaderboard_entries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leaderboards: {
        Row: {
          created_at: string
          game_id: string
          id: string
          key: string
          max_score_per_minute: number | null
          period: string
          sort: string
        }
        Insert: {
          created_at?: string
          game_id: string
          id?: string
          key: string
          max_score_per_minute?: number | null
          period?: string
          sort: string
        }
        Update: {
          created_at?: string
          game_id?: string
          id?: string
          key?: string
          max_score_per_minute?: number | null
          period?: string
          sort?: string
        }
        Relationships: [
          {
            foreignKeyName: "leaderboards_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      match_results: {
        Row: {
          duration_s: number
          ended_at: string
          game_id: string
          match_id: string
          payload: Json
          private: boolean
          recorded_at: string
          room_id: string
          rounds: number
          started_at: string
          winner_id: string | null
        }
        Insert: {
          duration_s: number
          ended_at: string
          game_id: string
          match_id: string
          payload: Json
          private: boolean
          recorded_at?: string
          room_id: string
          rounds?: number
          started_at: string
          winner_id?: string | null
        }
        Update: {
          duration_s?: number
          ended_at?: string
          game_id?: string
          match_id?: string
          payload?: Json
          private?: boolean
          recorded_at?: string
          room_id?: string
          rounds?: number
          started_at?: string
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "match_results_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      play_sessions: {
        Row: {
          ended_at: string | null
          game_id: string
          id: string
          playtime_s: number
          started_at: string
          user_id: string
          version: string | null
        }
        Insert: {
          ended_at?: string | null
          game_id: string
          id?: string
          playtime_s?: number
          started_at?: string
          user_id: string
          version?: string | null
        }
        Update: {
          ended_at?: string | null
          game_id?: string
          id?: string
          playtime_s?: number
          started_at?: string
          user_id?: string
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "play_sessions_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "play_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      presence: {
        Row: {
          game_id: string | null
          room_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          game_id?: string | null
          room_id?: string | null
          status: string
          updated_at?: string
          user_id: string
        }
        Update: {
          game_id?: string | null
          room_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "presence_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "presence_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          birth_date: string
          created_at: string
          display_name: string | null
          id: string
          privacy: Json
          updated_at: string
          username: string
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          birth_date: string
          created_at?: string
          display_name?: string | null
          id: string
          privacy?: Json
          updated_at?: string
          username: string
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          birth_date?: string
          created_at?: string
          display_name?: string | null
          id?: string
          privacy?: Json
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          action: string
          refilled_at: string
          tokens: number
          user_id: string
        }
        Insert: {
          action: string
          refilled_at?: string
          tokens: number
          user_id: string
        }
        Update: {
          action?: string
          refilled_at?: string
          tokens?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_achievements: {
        Row: {
          achievement_id: string
          unlocked_at: string
          user_id: string
        }
        Insert: {
          achievement_id: string
          unlocked_at?: string
          user_id: string
        }
        Update: {
          achievement_id?: string
          unlocked_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_achievements_achievement_id_fkey"
            columns: ["achievement_id"]
            isOneToOne: false
            referencedRelation: "achievements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_achievements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_sanctions: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          kind: string
          reason: string
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          kind: string
          reason: string
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          kind?: string
          reason?: string
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_sanctions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      abandon_play_session: { Args: { p_session_id: string }; Returns: undefined }
      block_user: { Args: { p_user_id: string }; Returns: undefined }
      contains_banned_word: { Args: { input: string }; Returns: boolean }
      end_play_session: {
        Args: { p_playtime_s?: number; p_session_id: string }
        Returns: undefined
      }
      friend_join_target: { Args: { p_friend_id: string }; Returns: Json }
      friends_presence: {
        Args: never
        Returns: {
          game_id: string
          game_title: string
          joinable: boolean
          room_id: string
          status: string
          user_id: string
        }[]
      }
      friendship_with: { Args: { p_user_id: string }; Returns: string }
      game_live_counts: {
        Args: never
        Returns: {
          game_id: string
          players: number
          rooms: number
        }[]
      }
      heartbeat: {
        Args: { p_game_id?: string; p_room_id?: string; p_status: string }
        Returns: Json
      }
      leaderboard_top: {
        Args: {
          p_board_key: string
          p_game_id: string
          p_limit?: number
          p_scope?: string
        }
        Returns: {
          avatar_url: string
          is_me: boolean
          rank: number
          score: number
          user_id: string
          username: string
        }[]
      }
      my_friend_requests: {
        Args: never
        Returns: {
          avatar_url: string
          created_at: string
          direction: string
          display_name: string
          user_id: string
          username: string
        }[]
      }
      my_friends: {
        Args: { p_limit?: number }
        Returns: {
          avatar_url: string
          display_name: string
          since: string
          user_id: string
          username: string
        }[]
      }
      my_leaderboard_rank: {
        Args: { p_board_key: string; p_game_id: string }
        Returns: Json
      }
      my_privacy: { Args: never; Returns: Json }
      period_key: { Args: { at?: string; period: string }; Returns: string }
      public_friends: {
        Args: { p_limit?: number; p_user_id: string }
        Returns: {
          avatar_url: string
          display_name: string
          since: string
          user_id: string
          username: string
        }[]
      }
      public_presence: { Args: { p_user_id: string }; Returns: Json }
      public_profile_games: {
        Args: { p_limit?: number; p_user_id: string }
        Returns: {
          best_score: number
          cover_url: string
          game_id: string
          icon_url: string
          last_played_at: string
          plays: number
          title: string
        }[]
      }
      public_profile_stats: { Args: { p_user_id: string }; Returns: Json }
      random_default_avatar: { Args: never; Returns: string }
      record_play: {
        Args: { p_game_id: string; p_playtime_s?: number }
        Returns: undefined
      }
      release_username: { Args: never; Returns: undefined }
      remove_friend: { Args: { p_user_id: string }; Returns: undefined }
      respond_friend_request: {
        Args: { p_accept: boolean; p_user_id: string }
        Returns: string
      }
      save_put: {
        Args: {
          p_data: Json
          p_game_id: string
          p_if_version?: number
          p_slot: string
        }
        Returns: number
      }
      search_profiles: {
        Args: { p_limit?: number; p_query: string }
        Returns: {
          avatar_url: string
          display_name: string
          friendship: string
          user_id: string
          username: string
        }[]
      }
      send_friend_request: { Args: { p_user_id: string }; Returns: string }
      server_record_match: { Args: { p_match: Json }; Returns: Json }
      server_record_visits: {
        Args: { p_count: number; p_game_id: string }
        Returns: undefined
      }
      server_remove_game_room: {
        Args: { p_room_id: string }
        Returns: undefined
      }
      server_sanction_status: { Args: { p_user_id: string }; Returns: Json }
      server_touch_game_rooms: {
        Args: { p_room_ids: string[] }
        Returns: number
      }
      server_upsert_game_room: {
        Args: { p_room: Json }
        Returns: undefined
      }
      start_play_session: {
        Args: { p_game_id: string; p_version?: string }
        Returns: string
      }
      submit_solo_score: {
        Args: {
          p_board_key: string
          p_game_id: string
          p_score: number
          p_session_id: string
        }
        Returns: Json
      }
      take_rate_limit_token: {
        Args: {
          p_action: string
          p_capacity: number
          p_refill_per_s: number
          p_user_id: string
        }
        Returns: boolean
      }
      unblock_user: { Args: { p_user_id: string }; Returns: undefined }
      unlock_achievement: {
        Args: { p_game_id: string; p_key: string }
        Returns: Json
      }
      username_available: { Args: { p_username: string }; Returns: boolean }
    }
    Enums: {
      age_rating: "4+" | "9+" | "12+" | "17+"
      friendship_status: "pending" | "accepted"
      game_engine: "playcanvas" | "phaser" | "custom"
      game_mode: "solo" | "quick" | "browser" | "private" | "party"
      game_orientation: "portrait" | "landscape" | "any"
      game_status: "draft" | "published" | "hidden"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      age_rating: ["4+", "9+", "12+", "17+"],
      friendship_status: ["pending", "accepted"],
      game_engine: ["playcanvas", "phaser", "custom"],
      game_mode: ["solo", "quick", "browser", "private", "party"],
      game_orientation: ["portrait", "landscape", "any"],
      game_status: ["draft", "published", "hidden"],
    },
  },
} as const
