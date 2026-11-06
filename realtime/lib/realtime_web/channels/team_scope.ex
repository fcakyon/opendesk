defmodule RealtimeWeb.Channels.TeamScope do
  @moduledoc """
  A private team's scope on a per-item topic (a ticket, a wiki page): the joiner
  names the item's private team with `team_id`, which must be in the token's
  `teams` claim in that workspace, and whatever carries a `team_id` reaches only
  sockets whose `teams` include it, without the `team_id`.

  The channel assigns `:teams` (the token's private teams in the topic's
  workspace) before calling `join_team/2`.
  """

  alias Realtime.Ids

  @doc """
  The join's `team_id`: `{:ok, nil}` without one, `{:ok, team_id}` (normalized)
  when it is one of the socket's private teams, else `:error`.
  """
  def join_team(%{"team_id" => team_id}, socket) when not is_nil(team_id) do
    if Ids.uuid?(team_id) and Ids.normalize(team_id) in Map.get(socket.assigns, :teams, []),
      do: {:ok, Ids.normalize(team_id)},
      else: :error
  end

  def join_team(_payload, _socket), do: {:ok, nil}

  @doc "Whether something scoped to `team_id` (nil: no team) reaches the socket."
  def visible?(nil, _socket), do: true
  def visible?(team_id, socket), do: team_id in Map.get(socket.assigns, :teams, [])

  @doc "Keeps the Presence metas the socket may see, without their `team_id`."
  def visible_presences(presences, socket) do
    for {key, %{metas: metas} = entry} <- presences,
        metas =
          for(meta <- metas, visible?(meta[:team_id], socket), do: Map.delete(meta, :team_id)),
        metas != [],
        into: %{},
        do: {key, %{entry | metas: metas}}
  end
end
