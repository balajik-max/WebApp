"""Aggregate v1 router."""
from fastapi import APIRouter

from app.api.v1 import (
    ai,
    analytics,
    auth,
    classification,
    datasets,
    features,
    health,
    map_context,
    placemarks,
    point_verifications,
    review_items,
    survey_requests,
    system,
    visualization,
)

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(system.router, tags=["system"])
api_router.include_router(datasets.router, prefix="/v1/datasets", tags=["datasets"])
api_router.include_router(features.router, prefix="/v1/features", tags=["features"])
api_router.include_router(review_items.router, prefix="/v1/review-items", tags=["reviews"])
api_router.include_router(survey_requests.router, prefix="/v1/survey-requests", tags=["survey-requests"])
api_router.include_router(analytics.router, prefix="/v1/analytics", tags=["analytics"])
api_router.include_router(ai.router, prefix="/v1/ai", tags=["ai"])
api_router.include_router(classification.router, prefix="/v1/classification", tags=["classification"])
api_router.include_router(visualization.router, prefix="/v1/visualization", tags=["visualization"])
api_router.include_router(placemarks.router, prefix="/v1/placemarks", tags=["placemarks"])
api_router.include_router(point_verifications.router, prefix="/v1/point-verifications", tags=["point-verifications"])
api_router.include_router(map_context.router, prefix="/v1/map-context", tags=["map-context"])
