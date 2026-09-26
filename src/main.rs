mod cloud;
mod resources;
mod responses;

use mimalloc::MiMalloc;

// glibc keeps freed pages inside per-thread arenas; mimalloc returns them.
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    cloud::serve().await
}
