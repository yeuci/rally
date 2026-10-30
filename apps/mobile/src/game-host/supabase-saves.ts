import type { Json } from '@rally/db';
import { supabase } from '@/lib/supabase';
import { HostError } from './bridge';
import { mapSaveError, type SaveStore } from './saves';

/**
 * `game_saves` through Supabase as the signed-in user: reads are owner-only via RLS, writes go through the
 * `save_put` RPC (optimistic concurrency; raises `CONFLICT: …` with SQLSTATE 40001 on a version mismatch).
 */
export function createSupabaseSaveStore(userId: string, gameId: string): SaveStore {
  return {
    async get(slot) {
      const { data, error } = await supabase
        .from('game_saves')
        .select('data, version')
        .eq('user_id', userId)
        .eq('game_id', gameId)
        .eq('slot', slot)
        .maybeSingle();
      if (error) throw new HostError('INTERNAL', error.message);
      return data ? { data: data.data, version: data.version } : { data: null, version: 0 };
    },

    async put(slot, data, ifVersion) {
      const { data: version, error } = await supabase.rpc('save_put', {
        p_game_id: gameId,
        p_slot: slot,
        p_data: data as Json,
        ...(ifVersion !== undefined ? { p_if_version: ifVersion } : {}),
      });
      if (error) throw mapSaveError(error);
      return { version };
    },
  };
}
