# Multi-PC Deployment with Docker Swarm
# Run all commands from PC1 (your current machine)

# ============================================
# STEP 1: Initialize Swarm on PC1 (Manager)
# ============================================
docker swarm init --advertise-addr 192.168.10.94

# This prints a token like:
# SWMTKN-1-xxxxx-xxxxx
# Copy this token!

# ============================================
# STEP 2: Join Worker PCs (PC2-PC5)
# On each worker PC, run:
# ============================================
docker swarm join --token SWMTKN-1-xxxxx-xxxxx 192.168.10.94:2377

# ============================================
# STEP 3: Join DB Server (PC6) as Manager
# On PC6, run:
# ============================================
docker swarm join --token SWMTKN-1-xxxxx-xxxxx 192.168.10.94:2377

# ============================================
# STEP 4: Verify Cluster (Run on PC1)
# ============================================
docker node ls

# Should show 6 nodes

# ============================================
# STEP 5: Create Overlay Network
# ============================================
docker network create --driver overlay --attachable davangere-net

# ============================================
# STEP 6: Deploy from PC1
# Run from your project folder:
# ============================================
docker stack deploy -c docker-compose.yml davangere

# ============================================
# STEP 7: Check Status
# ============================================
docker stack services davangere
docker service logs davangere_backend -f
