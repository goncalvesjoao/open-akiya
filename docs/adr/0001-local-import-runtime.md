# Run area imports locally with Supabase Postgres

Open Akiya is distributed as an open-source application that people run locally, with collected listings retained in their own installation. Use local Supabase Postgres and a local worker independent of browser lifetime, accepting the Docker and Supabase setup cost to retain the existing database foundation and persistent job recovery rather than introducing a second storage architecture. The map with synthetic listings is independently releasable before the worker and first permitted live-source integration.
