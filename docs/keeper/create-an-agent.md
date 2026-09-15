# Create an agent

Keywords: create agent, recruit, agent builder, new agent, version, grants, keys, profile

1. Open **Agents** and choose **Recruit an agent**.
2. Fill in name, role, objective and instructions.
3. Tick the **keys** (capabilities) it may use. For each, choose permissions and autonomy:
   - **AUTONOMOUS**: acts without asking.
   - **ALWAYS_APPROVE**: asks you first, every time.
   - **CONDITIONAL**: a low-risk read may run on measured performance; anything else asks you.
   SPEND, TRADE, PUBLISH and DELETE can never be AUTONOMOUS.
4. Set the **execution profile** if needed: preferred tier (CHEAP, MID, STRONG), a provider restriction, and loop limits (at most 12 iterations and 15 active minutes).
5. Save. The agent and its keys are created in one Registry write.

Editing never changes an existing agent: **New version** creates the next version with its own keys. Runs always record the exact version that did the work.
