import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// The public landing page also works without a configured backend.
export const supabase = url && key ? createClient(url, key) : null
