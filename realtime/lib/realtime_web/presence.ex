defmodule RealtimeWeb.Presence do
  @moduledoc "Who is on a ticket or a wiki page, and doing what. Replicated across the cluster."
  use Phoenix.Presence, otp_app: :realtime, pubsub_server: Realtime.PubSub
end
