defmodule RealtimeWeb.PrivateTicketTest do
  @moduledoc "A private team's ticket topic: presence, typing and live previews reach only that team."
  use RealtimeWeb.ChannelCase, async: true

  alias Phoenix.Socket.Message
  alias Realtime.Fanout
  alias RealtimeWeb.{ContactChannel, TicketChannel}

  @forbidden {:error, %{reason: "forbidden"}}

  setup do
    wid = Tokens.uuid()
    team = Tokens.uuid()
    tid = Tokens.uuid()

    %{
      wid: wid,
      team: team,
      tid: tid,
      topic: "ticket:#{wid}:#{tid}",
      member: Tokens.ws_claims(%{"wid" => wid, "name" => "Mia", "teams" => [team]}),
      outsider: Tokens.ws_claims(%{"wid" => wid, "name" => "Otto"})
    }
  end

  # Joins in its own process (its own transport) and forwards what the socket is pushed.
  defp join_as(claims, topic, params) do
    parent = self()
    {:ok, socket} = connect_claims(claims)

    pid =
      spawn_link(fn ->
        {:ok, _, channel} = join(%{socket | transport_pid: self()}, TicketChannel, topic, params)
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

  describe "join" do
    test "a team_id must be one of the token's teams", c do
      {:ok, member} = connect_claims(c.member)
      {:ok, outsider} = connect_claims(c.outsider)

      assert {:ok, _, _} =
               subscribe_and_join(member, TicketChannel, c.topic, %{
                 "team_id" => String.upcase(c.team)
               })

      for {socket, team} <- [{outsider, c.team}, {member, Tokens.uuid()}, {member, "nope"}] do
        assert subscribe_and_join(socket, TicketChannel, c.topic, %{"team_id" => team}) ==
                 @forbidden
      end

      assert {:ok, _, _} = subscribe_and_join(outsider, TicketChannel, c.topic, %{})
    end
  end

  describe "presence and typing" do
    test "a member's presence and typing are hidden from sockets without the team", c do
      {outsider, _, state} = join_as(c.outsider, c.topic, %{})
      osub = c.outsider["sub"]
      assert Map.keys(state) == [osub]

      assert_receive {^outsider,
                      %Message{event: "presence_diff", payload: %{joins: %{^osub => _}}}}

      {member, channel, state} = join_as(c.member, c.topic, %{"team_id" => c.team})
      assert Map.has_key?(state, c.outsider["sub"])
      assert %{metas: [meta]} = state[c.member["sub"]]
      refute Map.has_key?(meta, :team_id)

      msub = c.member["sub"]
      assert_receive {^member, %Message{event: "presence_diff", payload: %{joins: %{^msub => _}}}}
      refute_receive {^outsider, %Message{event: "presence_diff"}}, 100

      push(channel, "typing", %{})
      refute_receive {^outsider, %Message{event: "typing"}}, 100

      {_other, _, state} =
        join_as(Map.put(c.member, "sub", Tokens.uuid()), c.topic, %{"team_id" => c.team})

      assert Map.has_key?(state, msub)
    end

    test "a member sees a teammate's typing without the team_id", c do
      {_member, channel, _} = join_as(c.member, c.topic, %{"team_id" => c.team})
      mate = Map.merge(c.member, %{"sub" => Tokens.uuid(), "name" => "Max"})
      {mate_pid, _, _} = join_as(mate, c.topic, %{"team_id" => c.team})

      push(channel, "typing", %{})
      msub = c.member["sub"]
      expected = %{user_id: msub, name: "Mia"}
      assert_receive {^mate_pid, %Message{event: "typing", payload: ^expected}}
    end
  end

  describe "live previews" do
    setup c do
      contact = Tokens.widget_claims(%{"wid" => c.wid})
      {:ok, k} = connect_claims(contact)
      {:ok, _, _} = subscribe_and_join(k, ContactChannel, "contact:#{c.wid}:#{contact["sub"]}")
      %{cid: contact["sub"]}
    end

    defp live(c, team) do
      %{
        "workspace_id" => c.wid,
        "ticket_id" => c.tid,
        "contact_id" => c.cid,
        "team_id" => team,
        "type" => "ai.reply.delta",
        "data" => %{"reply_id" => Tokens.uuid(), "ticket_id" => c.tid, "text" => "Hi"}
      }
    end

    test "a private team's preview reaches its members and the visitor, not other agents", c do
      {member, _, _} = join_as(c.member, c.topic, %{"team_id" => c.team, "watch" => true})
      {outsider, _, _} = join_as(c.outsider, c.topic, %{"watch" => true})
      ev = live(c, String.upcase(c.team))
      contact_topic = "contact:#{c.wid}:#{c.cid}"

      assert {:ok, _} = Fanout.handle("od.live." <> c.wid, Jason.encode!(ev))
      expected = %{"type" => "ai.reply.delta", "data" => ev["data"]}
      assert_receive {^member, %Message{event: "live", payload: ^expected}}
      assert_receive %Message{topic: ^contact_topic, event: "live", payload: ^expected}
      refute_receive {^outsider, %Message{event: "live"}}, 100
    end

    test "a preview without a team reaches every agent on the ticket", c do
      {member, _, _} = join_as(c.member, c.topic, %{"team_id" => c.team})
      {outsider, _, _} = join_as(c.outsider, c.topic, %{})

      assert {:ok, _} =
               Fanout.handle(
                 "od.live." <> c.wid,
                 Jason.encode!(Map.delete(live(c, nil), "team_id"))
               )

      assert_receive {^member, %Message{event: "live"}}
      assert_receive {^outsider, %Message{event: "live"}}
    end

    test "a malformed team_id is dropped", c do
      assert Fanout.handle("od.live." <> c.wid, Jason.encode!(live(c, "team"))) ==
               {:error, :invalid_live}
    end
  end
end
