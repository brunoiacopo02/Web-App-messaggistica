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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      campaigns: {
        Row: {
          ac_list_match: string
          active: boolean
          created_at: string
          id: number
          name: string
          owner: string
          template_variables: Json
          twilio_template_sid: string
          updated_at: string
        }
        Insert: {
          ac_list_match: string
          active?: boolean
          created_at?: string
          id?: number
          name: string
          owner?: string
          template_variables?: Json
          twilio_template_sid: string
          updated_at?: string
        }
        Update: {
          ac_list_match?: string
          active?: boolean
          created_at?: string
          id?: number
          name?: string
          owner?: string
          template_variables?: Json
          twilio_template_sid?: string
          updated_at?: string
        }
        Relationships: []
      }
      // NB: le colonne gdo_video_* e gdo_appuntamento_at (migration 20260801000001)
      // sono aggiunte a mano in attesa del prossimo `npm run supabase:gen-types`, che
      // le riprodurrà identiche. Stesso trattamento già dato a `messages.sender`.
      conversations: {
        Row: {
          ai_dropoff_stage: string | null
          ai_insight_at: string | null
          ai_objection_category: string | null
          ai_objection_note: string | null
          ai_lock_at: string | null
          ai_paused_at: string | null
          ai_owner: string | null
          ai_started_at: string | null
          ai_status: string | null
          ai_summary: string | null
          ai_summary_at: string | null
          bot_followups_sent: number
          bot_outcome: string | null
          bot_outcome_at: string | null
          bot_report: Json | null
          bot_scheduled_at: string | null
          campaign_id: number | null
          cancel_requested_at: string | null
          handed_off_at: string | null
          handed_off_reason: string | null
          created_at: string
          crm_funnel: string | null
          crm_lead_id: string | null
          gdo_agenda_at: string | null
          gdo_agenda_esito: string | null
          gdo_appuntamento_at: string | null
          gdo_noemi_reminded_at: string | null
          gdo_video_followups_sent: number
          gdo_video_sent_at: string | null
          gdo_video_url: string | null
          gdo_video_watched_at: string | null
          id: number
          last_inbound_at: string | null
          last_message_at: string
          last_message_preview: string | null
          lead_id: number
          unread_count: number
          wa_number: string | null
        }
        Insert: {
          ai_dropoff_stage?: string | null
          ai_insight_at?: string | null
          ai_objection_category?: string | null
          ai_objection_note?: string | null
          ai_lock_at?: string | null
          ai_paused_at?: string | null
          ai_owner?: string | null
          ai_started_at?: string | null
          ai_status?: string | null
          ai_summary?: string | null
          ai_summary_at?: string | null
          bot_followups_sent?: number
          bot_outcome?: string | null
          bot_outcome_at?: string | null
          bot_report?: Json | null
          bot_scheduled_at?: string | null
          campaign_id?: number | null
          cancel_requested_at?: string | null
          handed_off_at?: string | null
          handed_off_reason?: string | null
          created_at?: string
          crm_funnel?: string | null
          crm_lead_id?: string | null
          gdo_agenda_at?: string | null
          gdo_agenda_esito?: string | null
          gdo_appuntamento_at?: string | null
          gdo_noemi_reminded_at?: string | null
          gdo_video_followups_sent?: number
          gdo_video_sent_at?: string | null
          gdo_video_url?: string | null
          gdo_video_watched_at?: string | null
          id?: number
          last_inbound_at?: string | null
          last_message_at?: string
          last_message_preview?: string | null
          lead_id: number
          unread_count?: number
          wa_number?: string | null
        }
        Update: {
          ai_dropoff_stage?: string | null
          ai_insight_at?: string | null
          ai_objection_category?: string | null
          ai_objection_note?: string | null
          ai_lock_at?: string | null
          ai_paused_at?: string | null
          ai_owner?: string | null
          ai_started_at?: string | null
          ai_status?: string | null
          ai_summary?: string | null
          ai_summary_at?: string | null
          bot_followups_sent?: number
          bot_outcome?: string | null
          bot_outcome_at?: string | null
          bot_report?: Json | null
          bot_scheduled_at?: string | null
          campaign_id?: number | null
          cancel_requested_at?: string | null
          handed_off_at?: string | null
          handed_off_reason?: string | null
          created_at?: string
          crm_funnel?: string | null
          crm_lead_id?: string | null
          gdo_agenda_at?: string | null
          gdo_agenda_esito?: string | null
          gdo_appuntamento_at?: string | null
          gdo_noemi_reminded_at?: string | null
          gdo_video_followups_sent?: number
          gdo_video_sent_at?: string | null
          gdo_video_url?: string | null
          gdo_video_watched_at?: string | null
          id?: number
          last_inbound_at?: string | null
          last_message_at?: string
          last_message_preview?: string | null
          lead_id?: number
          unread_count?: number
          wa_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      event_log: {
        Row: {
          created_at: string
          id: number
          level: string
          message: string | null
          payload: Json | null
          type: string
        }
        Insert: {
          created_at?: string
          id?: number
          level?: string
          message?: string | null
          payload?: Json | null
          type: string
        }
        Update: {
          created_at?: string
          id?: number
          level?: string
          message?: string | null
          payload?: Json | null
          type?: string
        }
        Relationships: []
      }
      lead_analysis_reports: {
        Row: {
          generated_at: string
          id: number
          payload: Json
          period: string
        }
        Insert: {
          generated_at?: string
          id?: never
          payload: Json
          period?: string
        }
        Update: {
          generated_at?: string
          id?: never
          payload?: Json
          period?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          ac_contact_id: string | null
          created_at: string
          email: string | null
          first_name: string | null
          id: number
          last_name: string | null
          phone_e164: string
        }
        Insert: {
          ac_contact_id?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: number
          last_name?: string | null
          phone_e164: string
        }
        Update: {
          ac_contact_id?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: number
          last_name?: string | null
          phone_e164?: string
        }
        Relationships: []
      }
      // NB: `sender` (migration 20260731000001) aggiunto a mano in attesa del prossimo
      // `npm run supabase:gen-types`, che lo riprodurrà identico. Preferito ai cast `as any`
      // sparsi sui 13 punti d'invio (il precedente di `campaigns.owner` è ciò che si evita).
      messages: {
        Row: {
          body: string
          conversation_id: number
          created_at: string
          direction: string
          id: number
          is_template: boolean
          read_at: string | null
          sender: string | null
          template_sid: string | null
          template_vars: Json | null
          twilio_error_code: number | null
          twilio_sid: string | null
          twilio_status: string | null
        }
        Insert: {
          body: string
          conversation_id: number
          created_at?: string
          direction: string
          id?: number
          is_template?: boolean
          read_at?: string | null
          sender?: string | null
          template_sid?: string | null
          template_vars?: Json | null
          twilio_error_code?: number | null
          twilio_sid?: string | null
          twilio_status?: string | null
        }
        Update: {
          body?: string
          conversation_id?: number
          created_at?: string
          direction?: string
          id?: number
          is_template?: boolean
          read_at?: string | null
          sender?: string | null
          template_sid?: string | null
          template_vars?: Json | null
          twilio_error_code?: number | null
          twilio_sid?: string | null
          twilio_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
