defmodule RealtimeWeb.WikiPageChannel do
  @moduledoc """
  `wiki_page:<wid>:<page_id>`: who is viewing or editing a wiki page, through
  Phoenix Presence. Joined by `ws` tokens with `kind=user` that cover the
  workspace (their own, or for a person one of the others their `workspaces`
  claim lists); the channel acts with the private teams the token gives there.
  The app joins only for workspace and team pages, never for a private page.

  Join params:

    * `{watch: true}` receives Presence without being tracked; its `"presence"`
      pushes are ignored.
    * `{state: "viewing" | "editing" | "idle"}` is the initial Presence state
      (default `"viewing"`).
    * `{team_id}` is the page's private team. It must be in the token's `teams`
      claim (else the join is forbidden), and it scopes the joiner's Presence
      meta to that team: `handle_out` drops it for sockets whose `teams` claim
      lacks the team (and strips `team_id` from what it pushes).

  Client pushes:

    * `"presence"` `{state: "viewing" | "editing" | "idle"}` updates the meta.
  """

  use Phoenix.Channel, log_join: false, log_handle_in: false

  intercept ["presence_diff"]

  alias Realtime.Auth
  alias Realtime.Ids
  alias RealtimeWeb.Channels.{Guard, TeamScope}
  alias RealtimeWeb.Presence

  @states ~w(viewing editing idle)

  @impl true
  def join("wiki_page:" <> rest, payload, %{assigns: %{kind: :user} = assigns} = socket) do
    with [wid, page_id] <- String.split(rest, ":"),
         %{teams: teams} <- Auth.workspace(assigns, wid),
         true <- Ids.uuid?(page_id) and page_id == Ids.normalize(page_id),
         socket = socket |> assign(:wid, wid) |> assign(:teams, teams),
         {:ok, team_id} <- TeamScope.join_team(payload, socket) do
      if Guard.join_allowed?(socket) do
        send(self(), :after_join)

        socket =
          socket
          |> assign(:page_id, page_id)
          |> assign(:team_id, team_id)
          |> assign(:watch, watch?(payload))
          |> assign(:initial_state, initial_state(payload))

        {:ok, Guard.ok_reply(), socket}
      else
        {:error, %{reason: "rate_limited"}}
      end
    else
      _ -> Guard.forbidden(:wiki_page)
    end
  end

  def join(_topic, _payload, _socket), do: Guard.forbidden(:wiki_page)

  @impl true
  def handle_info(:after_join, socket) do
    unless socket.assigns.watch do
      {:ok, _ref} =
        Presence.track(socket, socket.assigns.sub, meta(socket, socket.assigns.initial_state))
    end

    push(socket, "presence_state", TeamScope.visible_presences(Presence.list(socket), socket))
    {:noreply, socket}
  end

  @impl true
  def handle_out("presence_diff", %{joins: joins, leaves: leaves}, socket) do
    joins = TeamScope.visible_presences(joins, socket)
    leaves = TeamScope.visible_presences(leaves, socket)

    if joins != %{} or leaves != %{},
      do: push(socket, "presence_diff", %{joins: joins, leaves: leaves})

    {:noreply, socket}
  end

  @impl true
  def handle_in(event, payload, socket) do
    case Guard.throttle_push(socket) do
      {:ok, socket} -> handle_push(event, payload, socket)
      {:drop, socket} -> {:noreply, socket}
      reply -> reply
    end
  end

  # A watcher is not in Presence.
  defp handle_push("presence", _payload, %{assigns: %{watch: true}} = socket),
    do: {:noreply, socket}

  defp handle_push("presence", %{"state" => state}, socket) when state in @states do
    {:ok, _ref} =
      Presence.update(socket, socket.assigns.sub, fn meta -> Map.put(meta, :state, state) end)

    {:reply, :ok, socket}
  end

  defp handle_push(_event, _payload, socket), do: Guard.invalid(socket)

  defp watch?(%{"watch" => true}), do: true
  defp watch?(_), do: false

  defp initial_state(%{"state" => state}) when state in @states, do: state
  defp initial_state(_), do: "viewing"

  defp meta(socket, state) do
    %{
      user_id: socket.assigns.sub,
      name: socket.assigns.name,
      avatar: socket.assigns.avatar,
      state: state,
      online_at: DateTime.utc_now() |> DateTime.to_iso8601(),
      team_id: socket.assigns.team_id
    }
  end
end
