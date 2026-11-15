defmodule RealtimeWeb.WikiPageChannelTest do
  @moduledoc "`wiki_page:<wid>:<page_id>`: who is viewing or editing a wiki page."
  use RealtimeWeb.ChannelCase, async: true

  alias Phoenix.Socket.{Broadcast, Message}
  alias RealtimeWeb.{Presence, WikiPageChannel}

  @forbidden {:error, %{reason: "forbidden"}}

  setup do
    wid = Tokens.uuid()
    agent = Tokens.ws_claims(%{"wid" => wid})
    {:ok, socket} = connect_claims(agent)
    pid = Tokens.uuid()

    %{wid: wid, uid: agent["sub"], socket: socket, page: pid, topic: "wiki_page:#{wid}:#{pid}"}
  end

  describe "join" do
    test "users of the workspace join, as do a person's other workspaces", c do
      assert {:ok, %{server_time: _}, _} = subscribe_and_join(c.socket, WikiPageChannel, c.topic)

      b = Tokens.uuid()

      {:ok, person} =
        connect_claims(
          Tokens.ws_claims(%{"workspaces" => %{b => %{"role" => "viewer", "teams" => []}}})
        )

      assert {:ok, _, _} =
               subscribe_and_join(person, WikiPageChannel, "wiki_page:#{b}:#{c.page}")
    end

    test "other workspaces, API keys, contacts and malformed ids are forbidden", c do
      {:ok, key} = connect_claims(Tokens.ws_claims(%{"kind" => "api_key", "wid" => c.wid}))
      {:ok, contact} = connect_claims(Tokens.widget_claims(%{"wid" => c.wid}))

      for {socket, topic} <- [
            {c.socket, "wiki_page:#{Tokens.uuid()}:#{c.page}"},
            {key, c.topic},
            {contact, c.topic},
            {c.socket, "wiki_page:#{c.wid}:not-a-uuid"},
            {c.socket, "wiki_page:#{c.wid}:#{String.upcase(c.page)}"},
            {c.socket, "wiki_page:#{c.wid}"},
            {c.socket, "wiki_page:#{c.wid}:#{c.page}:extra"}
          ] do
        assert subscribe_and_join(socket, WikiPageChannel, topic) == @forbidden, topic
      end
    end

    test "a team_id must be one of the token's teams", c do
      team = Tokens.uuid()
      {:ok, member} = connect_claims(Tokens.ws_claims(%{"wid" => c.wid, "teams" => [team]}))

      assert {:ok, _, _} =
               subscribe_and_join(member, WikiPageChannel, c.topic, %{
                 "team_id" => String.upcase(team)
               })

      for {socket, t} <- [{c.socket, team}, {member, Tokens.uuid()}, {member, "nope"}] do
        assert subscribe_and_join(socket, WikiPageChannel, c.topic, %{"team_id" => t}) ==
                 @forbidden
      end
    end
  end

  describe "presence" do
    setup c do
      {:ok, _, channel} = subscribe_and_join(c.socket, WikiPageChannel, c.topic)
      %{channel: channel}
    end

    test "joining tracks the user as viewing and pushes presence_state", c do
      uid = c.uid
      assert_push "presence_state", %{^uid => %{metas: [meta]}}

      assert %{
               user_id: ^uid,
               name: "Anna",
               avatar: "https://example.test/a.png",
               state: "viewing",
               online_at: online_at
             } = meta

      refute Map.has_key?(meta, :team_id)
      assert {:ok, _, _} = DateTime.from_iso8601(online_at)
      assert %{^uid => _} = Presence.list(c.topic)
    end

    test "a second user sees the first in presence_state, and the first gets a diff", c do
      assert_push "presence_state", _
      other = Tokens.ws_claims(%{"wid" => c.wid, "name" => "Ben"})
      {:ok, o} = connect_claims(other)
      {:ok, _, _} = subscribe_and_join(o, WikiPageChannel, c.topic, %{"state" => "editing"})

      assert_push "presence_state", state
      assert Map.has_key?(state, c.uid)
      assert Map.has_key?(state, other["sub"])
      osub = other["sub"]

      assert_receive %Broadcast{
        event: "presence_diff",
        payload: %{joins: %{^osub => %{metas: [%{name: "Ben", state: "editing"}]}}}
      }
    end

    test "presence pushes update the state", c do
      for state <- ~w(editing idle viewing) do
        ref = push(c.channel, "presence", %{"state" => state})
        assert_reply ref, :ok
        assert %{metas: [%{state: ^state}]} = Presence.list(c.topic)[c.uid]
      end
    end

    test "invalid presence states and other pushes are refused", c do
      for {event, payload} <- [
            {"presence", %{"state" => "replying"}},
            {"presence", %{"state" => 1}},
            {"presence", %{}},
            {"typing", %{}}
          ] do
        ref = push(c.channel, event, payload)
        assert_reply ref, :error, %{reason: "invalid"}
      end

      assert %{metas: [%{state: "viewing"}]} = Presence.list(c.topic)[c.uid]
    end

    test "a watcher gets presence but is not tracked", c do
      uid = c.uid
      assert_push "presence_state", _
      assert_receive %Broadcast{event: "presence_diff", payload: %{joins: %{^uid => _}}}
      other = Tokens.ws_claims(%{"wid" => c.wid, "name" => "Ben"})
      {:ok, o} = connect_claims(other)
      {:ok, _, w} = subscribe_and_join(o, WikiPageChannel, c.topic, %{"watch" => true})

      assert_push "presence_state", state
      assert Map.has_key?(state, uid)
      refute Map.has_key?(Presence.list(c.topic), other["sub"])

      push(w, "presence", %{"state" => "editing"})
      refute_receive %Broadcast{event: "presence_diff"}, 100
      refute Map.has_key?(Presence.list(c.topic), other["sub"])
    end
  end

  describe "a private team's page" do
    setup c do
      team = Tokens.uuid()

      %{
        team: team,
        member: Tokens.ws_claims(%{"wid" => c.wid, "name" => "Mia", "teams" => [team]}),
        outsider: Tokens.ws_claims(%{"wid" => c.wid, "name" => "Otto"})
      }
    end

    # Joins in its own process (its own transport) and forwards what the socket is pushed.
    defp join_as(claims, topic, params) do
      parent = self()
      {:ok, socket} = connect_claims(claims)

      pid =
        spawn_link(fn ->
          {:ok, _, channel} =
            join(%{socket | transport_pid: self()}, WikiPageChannel, topic, params)

          send(parent, {:joined, self(), channel})
          forward(parent)
        end)

      assert_receive {:joined, ^pid, channel}, 2_000
      assert_receive {^pid, %Message{event: "presence_state", payload: state}}
      {pid, channel, state}
    end

    defp forward(parent) do
      receive do
        %Message{} = msg -> send(parent, {self(), msg})
        _ -> :ok
      end

      forward(parent)
    end

    test "a member's presence is hidden from sockets without the team", c do
      {outsider, _, state} = join_as(c.outsider, c.topic, %{})
      osub = c.outsider["sub"]
      assert Map.keys(state) == [osub]

      assert_receive {^outsider,
                      %Message{event: "presence_diff", payload: %{joins: %{^osub => _}}}}

      {member, channel, state} =
        join_as(c.member, c.topic, %{"team_id" => c.team, "state" => "editing"})

      assert Map.has_key?(state, osub)
      assert %{metas: [meta]} = state[c.member["sub"]]
      assert meta.state == "editing"
      refute Map.has_key?(meta, :team_id)

      msub = c.member["sub"]
      assert_receive {^member, %Message{event: "presence_diff", payload: %{joins: %{^msub => _}}}}
      refute_receive {^outsider, %Message{event: "presence_diff"}}, 100

      push(channel, "presence", %{"state" => "idle"})

      assert_receive {^member,
                      %Message{
                        event: "presence_diff",
                        payload: %{joins: %{^msub => %{metas: [%{state: "idle"}]}}}
                      }}

      refute_receive {^outsider, %Message{event: "presence_diff"}}, 100

      {_mate, _, state} =
        join_as(Map.put(c.member, "sub", Tokens.uuid()), c.topic, %{
          "team_id" => c.team,
          "watch" => true
        })

      assert %{metas: [%{state: "idle"}]} = state[msub]
    end
  end
end
