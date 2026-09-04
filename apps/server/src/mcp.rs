#![recursion_limit = "512"]

mod crypto;
mod design_budgets;
mod design_revisions;
mod falkordb;
mod forecasts;
mod indexer;
mod library;
mod mcp_app;
mod project_graphs;
mod qa;
mod qa_plan_revisions;
mod resources;
mod workflows;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mcp_app::run().await
}
