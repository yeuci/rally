// Hand-written to match `supabase gen types typescript` output for supabase/migrations (M1).
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
      games: {
        Row: {
          age_rating: Database["public"]["Enums"]["age_rating"]
          created_at: string
          current_version_id: string | null
          description: string
          engine: Database["public"]["Enums"]["game_engine"]
          featured_rank: number | null
          genres: string[]
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
        }
        Insert: {
          age_rating?: Database["public"]["Enums"]["age_rating"]
          created_at?: string
          current_version_id?: string | null
          description?: string
          engine: Database["public"]["Enums"]["game_engine"]
          featured_rank?: number | null
          genres?: string[]
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
        }
        Update: {
          age_rating?: Database["public"]["Enums"]["age_rating"]
          created_at?: string
          current_version_id?: string | null
          description?: string
          engine?: Database["public"]["Enums"]["game_engine"]
          featured_rank?: number | null
          genres?: string[]
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      contains_banned_word: { Args: { input: string }; Returns: boolean }
      record_play: {
        Args: { p_game_id: string; p_playtime_s?: number }
        Returns: undefined
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
      username_available: { Args: { p_username: string }; Returns: boolean }
    }
    Enums: {
      age_rating: "4+" | "9+" | "12+" | "17+"
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
      game_engine: ["playcanvas", "phaser", "custom"],
      game_mode: ["solo", "quick", "browser", "private", "party"],
      game_orientation: ["portrait", "landscape", "any"],
      game_status: ["draft", "published", "hidden"],
    },
  },
} as const
