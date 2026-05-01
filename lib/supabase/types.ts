export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      campaigns: {
        Row: {
          ac_list_match: string
          active: boolean
          created_at: string
          id: number
          name: string
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
          template_variables?: Json
          twilio_template_sid?: string
          updated_at?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          campaign_id: number | null
          created_at: string
          id: number
          last_inbound_at: string | null
          last_message_at: string
          lead_id: number
          unread_count: number
        }
        Insert: {
          campaign_id?: number | null
          created_at?: string
          id?: number
          last_inbound_at?: string | null
          last_message_at?: string
          lead_id: number
          unread_count?: number
        }
        Update: {
          campaign_id?: number | null
          created_at?: string
          id?: number
          last_inbound_at?: string | null
          last_message_at?: string
          lead_id?: number
          unread_count?: number
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
      messages: {
        Row: {
          body: string
          conversation_id: number
          created_at: string
          direction: string
          id: number
          is_template: boolean
          read_at: string | null
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
